import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { PlayoffSaveDto, ScheduleAvailabilityRequestDto, SchedulePreviewDto, ScheduleSaveDto, SeasonPlayoffSaveDto, SeasonScheduleSaveDto } from './league.dto';
import { estimateCourtCapacity, planSchedule, roundRobin, scheduleIssues, scheduleMatches, SchedulePlacementError, validateSchedule, type ExistingGame, type ScheduleAvailability, type ScheduleGame, type ScheduleMatch } from './schedule-algorithm';
import { calculateStandings } from './standings';

type Database = Kysely<DB> | Transaction<DB>;
type DivisionContext = Awaited<ReturnType<ScheduleService['context']>>;

@Injectable()
export class ScheduleService {
  constructor(private readonly database: DatabaseService) {}
  private get db() { return this.database.db; }

  private async context(user: string, divisionId: string, db: Database, lock = false) {
    let query = db.selectFrom('league.divisions as d')
      .innerJoin('league.seasons as s', 's.id', 'd.season_id')
      .innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['d.id as divisionId', 's.id as seasonId', 's.league_id as leagueId', 's.status',
        sql<string | null>`s.start_date::text`.as('startDate'), sql<string | null>`s.end_date::text`.as('endDate')])
      .where('d.id', '=', divisionId).where('o.owner_user_id', '=', user);
    if (lock) query = query.forUpdate('s');
    const context = await query.executeTakeFirst();
    if (!context) throw new NotFoundException();
    return context;
  }

  private async leagueLock(db: Database, leagueId: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${'shotclock:schedule:league:' + leagueId}, 0))`.execute(db);
  }

  private editable(context: DivisionContext) {
    if (context.status === 'completed') throw new BadRequestException('Completed seasons cannot be changed');
  }

  private teams(db: Database, divisionId: string) {
    return db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id')
      .select(['st.id', 't.name']).where('st.division_id', '=', divisionId).orderBy('st.id').execute();
  }

  private async validateVenues(db: Database, leagueId: string, availability: ScheduleAvailability) {
    if (!availability || !Array.isArray(availability.venueIds) || !availability.venueIds.length) throw new BadRequestException('Select at least one venue');
    const venues = await db.selectFrom('league.venues').select('id').where('league_id', '=', leagueId).where('id', 'in', availability.venueIds).execute();
    if (venues.length !== availability.venueIds.length) throw new BadRequestException('All venues must belong to this league');
  }

  private async existing(db: Database, leagueId: string): Promise<ExistingGame[]> {
    const games = await db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .select(['g.id', 'g.home_season_team_id', 'g.away_season_team_id', 'g.scheduled_at', 'g.venue_id', 'g.duration_minutes'])
      .where('s.league_id', '=', leagueId).where('g.scheduled_at', 'is not', null).execute();
    return games.map((game) => ({ id: game.id, homeTeamId: game.home_season_team_id, awayTeamId: game.away_season_team_id,
      scheduledAt: new Date(game.scheduled_at!).toISOString(), venueId: game.venue_id, durationMinutes: game.duration_minutes }));
  }

  private checkTeamAvailability(availability: ScheduleAvailability, teamIds: Iterable<string>) {
    const allowed = new Set(teamIds);
    if (availability?.teamUnavailability?.some((entry) => !allowed.has(entry.teamId))) throw new BadRequestException('Team availability includes a team outside this schedule');
  }

  private warnings(games: ScheduleGame[], context: DivisionContext, zone: string) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const outside = games.some((game) => {
      const parts = formatter.formatToParts(new Date(game.scheduledAt));
      const part = (type: string) => parts.find((item) => item.type === type)?.value;
      const date = `${part('year')}-${part('month')}-${part('day')}`;
      return (context.startDate && date < context.startDate) || (context.endDate && date > context.endDate);
    });
    return outside ? ['Some games are outside the season dates.'] : [];
  }

  private withNames(games: ScheduleGame[], teams: { id: string; name: string }[]) {
    const names = new Map(teams.map((team) => [team.id, team.name]));
    return games.map((game) => ({ ...game, homeName: names.get(game.homeTeamId) ?? '', awayName: names.get(game.awayTeamId) ?? '' }));
  }

  private sameMatches(expected: ScheduleMatch[], actual: ScheduleGame[]) {
    const key = (match: ScheduleMatch) => [match.stage, match.round, match.homeTeamId, match.awayTeamId].join(':');
    const left = expected.map(key).sort();
    const right = actual.map(key).sort();
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) throw new BadRequestException('The schedule has changed; generate a new preview');
  }

  // A draft may still be missing games the organizer has not placed, but it cannot add or repeat fixtures.
  private partOfMatches(expected: ScheduleMatch[], actual: ScheduleGame[]) {
    const key = (match: ScheduleMatch) => [match.stage, match.round, match.homeTeamId, match.awayTeamId].join(':');
    const remaining = new Map<string, number>();
    for (const match of expected) remaining.set(key(match), (remaining.get(key(match)) ?? 0) + 1);
    for (const game of actual) {
      const count = remaining.get(key(game)) ?? 0;
      if (!count) throw new BadRequestException('The schedule has changed; generate a new preview');
      remaining.set(key(game), count - 1);
    }
  }

  private trySchedule<T>(fn: () => T, teams: { id: string; name: string }[] = []): T {
    try { return fn(); } catch (error) {
      if (error instanceof SchedulePlacementError) {
        const home = teams.find((team) => team.id === error.match.homeTeamId)?.name;
        const away = teams.find((team) => team.id === error.match.awayTeamId)?.name;
        throw new BadRequestException(error.withTeamNames(home, away));
      }
      if (error instanceof Error && /work limit/i.test(error.message)) throw new BadRequestException('This schedule is too large to process safely. Try a single round robin or fewer venues. No games were saved.');
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid schedule');
    }
  }

  private async preliminary(db: Database, context: DivisionContext, input: SchedulePreviewDto) {
    this.editable(context);
    const [teams, existingSchedule, existingGame] = await Promise.all([
      this.teams(db, context.divisionId),
      db.selectFrom('league.division_schedules').select('id').where('division_id', '=', context.divisionId).executeTakeFirst(),
      db.selectFrom('league.games').select('id').where('division_id', '=', context.divisionId).where('stage', '=', 'preliminary').executeTakeFirst(),
    ]);
    if (existingSchedule || existingGame) throw new BadRequestException('Remove existing preliminary games before generating a schedule');
    if (teams.length < 2) throw new BadRequestException('At least two teams are required');
    if (teams.length > 32) throw new BadRequestException('A generated schedule supports at most 32 teams');
    if (input.playoffs && teams.length < 4) throw new BadRequestException('Playoffs require at least four teams');
    if (input.thirdPlace && !input.playoffs) throw new BadRequestException('A third-place game requires playoffs');
    await this.validateVenues(db, context.leagueId, input.availability);
    this.checkTeamAvailability(input.availability, teams.map((team) => team.id));
    const matches = this.trySchedule(() => roundRobin(teams.map((team) => team.id), input.format));
    return { teams, matches };
  }

  async status(user: string, divisionId: string) {
    const context = await this.context(user, divisionId, this.db);
    const [schedule, games] = await Promise.all([
      this.db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', divisionId).executeTakeFirst(),
      this.db.selectFrom('league.games').select(['stage', 'status']).where('division_id', '=', divisionId).execute(),
    ]);
    const prelim = games.filter((game) => game.stage === 'preliminary');
    const semifinals = games.filter((game) => game.stage === 'semifinal');
    let playoffStage: 'semifinal' | 'final' | null = null;
    if (schedule?.playoffs && prelim.length && prelim.every((game) => game.status === 'completed')) {
      if (!semifinals.length) playoffStage = 'semifinal';
      else if (semifinals.length === 2 && semifinals.every((game) => game.status === 'completed') && !games.some((game) => game.stage === 'final' || game.stage === 'third_place')) playoffStage = 'final';
    }
    return { hasSchedule: !!schedule, canGeneratePreliminary: context.status !== 'completed' && !schedule && !prelim.length,
      playoffStage: context.status === 'completed' ? null : playoffStage, playoffs: !!schedule?.playoffs, thirdPlace: !!schedule?.third_place };
  }

  private async seasonContext(user: string, seasonId: string, db: Database, lock = false) {
    let query = db.selectFrom('league.seasons as s').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['s.id as seasonId', 's.league_id as leagueId', 's.status', sql<string | null>`s.start_date::text`.as('startDate'), sql<string | null>`s.end_date::text`.as('endDate')])
      .where('s.id', '=', seasonId).where('o.owner_user_id', '=', user);
    if (lock) query = query.forUpdate('s');
    const season = await query.executeTakeFirst();
    if (!season) throw new NotFoundException();
    return season;
  }

  private async seasonDivisions(db: Database, season: Awaited<ReturnType<ScheduleService['seasonContext']>>) {
    const divisions = await db.selectFrom('league.divisions').select(['id', 'name']).where('season_id', '=', season.seasonId).orderBy('name').orderBy('id').execute();
    return Promise.all(divisions.map(async (division) => {
      const context = { ...season, divisionId: division.id };
      const [teams, schedule, games] = await Promise.all([
        this.teams(db, division.id),
        db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', division.id).executeTakeFirst(),
        db.selectFrom('league.games').select(['stage', 'status']).where('division_id', '=', division.id).execute(),
      ]);
      let playoff: Awaited<ReturnType<ScheduleService['playoffMatches']>> | null = null;
      let playoffReason = !schedule?.playoffs ? 'Playoffs are not enabled.' : 'Complete the previous round before scheduling playoffs.';
      if (schedule?.playoffs && season.status !== 'completed') {
        try { playoff = await this.playoffMatches(db, context); }
        catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
          playoffReason = error.message;
        }
      }
      const preliminaryReason = schedule || games.some((game) => game.stage === 'preliminary')
        ? 'This division already has preliminary games or a generated schedule.'
        : teams.length < 2 ? 'At least two teams are required.'
          : teams.length > 32 ? 'A generated schedule supports at most 32 teams.' : undefined;
      const playoffStage = playoff ? (playoff.matches[0]?.stage === 'semifinal' ? 'semifinal' as const : 'final' as const) : null;
      return { id: division.id, name: division.name, teamCount: teams.length, hasSchedule: !!schedule,
        canGeneratePreliminary: season.status !== 'completed' && !preliminaryReason,
        playoffs: !!schedule?.playoffs, thirdPlace: !!schedule?.third_place, playoffStage,
        preliminaryReason, playoffReason: playoff ? undefined : playoffReason, context, teams, playoff };
    }));
  }

  async seasonStatus(user: string, seasonId: string) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const divisions = await this.seasonDivisions(this.db, season);
    return { divisions: divisions.map(({ context: _context, teams: _teams, playoff: _playoff, ...division }) => division) };
  }

  private async seasonPlan(db: Database, season: Awaited<ReturnType<ScheduleService['seasonContext']>>, input: ScheduleAvailabilityRequestDto | SchedulePreviewDto, mode: 'preliminary' | 'playoffs', allowEmpty = false) {
    if (season.status === 'completed') throw new BadRequestException('Completed seasons cannot be changed');
    if (mode === 'preliminary' && 'thirdPlace' in input && input.thirdPlace && !input.playoffs) throw new BadRequestException('A third-place game requires playoffs');
    await this.validateVenues(db, season.leagueId, input.availability);
    const divisions = await this.seasonDivisions(db, season);
    this.checkTeamAvailability(input.availability, divisions.flatMap((division) => division.teams.map((team) => team.id)));
    const included = divisions.filter((division) => mode === 'preliminary' ? division.canGeneratePreliminary : !!division.playoff);
    const details = divisions.map((division) => {
      const eligible = included.includes(division);
      const reason = eligible ? undefined : mode === 'preliminary' ? division.preliminaryReason : division.playoffReason;
      const playoffs = mode === 'preliminary' ? !!('playoffs' in input && input.playoffs && division.teamCount >= 4) : division.playoffs;
      return { id: division.id, name: division.name, teamCount: division.teamCount, ...(reason ? { reason } : {}), playoffs,
        ...(division.playoffStage ? { playoffStage: division.playoffStage } : {}),
        ...(eligible && mode === 'preliminary' && 'playoffs' in input && input.playoffs && !playoffs ? { notice: 'Fewer than four teams; round robin only.' } : {}) };
    });
    if (!included.length && !allowEmpty) throw new BadRequestException(mode === 'preliminary' ? 'No divisions are eligible for schedule generation.' : 'No divisions are ready to schedule playoff games.');
    const matches = included.flatMap((division) => {
      const fixtures = mode === 'preliminary' ? roundRobin(division.teams.map((team) => team.id), (input as SchedulePreviewDto).format) : division.playoff!.matches;
      return fixtures.map((match) => ({ ...match, divisionId: division.id, groupId: division.id }));
    });
    if (matches.length > 5000) throw new BadRequestException('This schedule exceeds the 5,000-game batch limit.');
    return { included, details, matches };
  }

  private seasonPlacement(matches: (ScheduleMatch & { divisionId: string })[], availability: ScheduleAvailability, existing: ExistingGame[], divisions: { id: string; name: string; teams: { id: string; name: string }[] }[], mode: 'preliminary' | 'playoffs') {
    // Playoff divisions can be at different stages, so they do not share round order.
    const placementMatches = mode === 'playoffs' ? matches.map((match) => ({ ...match, round: 1 })) : matches;
    const plan = this.trySchedule(() => planSchedule(placementMatches, availability, existing));
    const unplaced = plan.unplaced.map(({ index, reason }) => {
      const match = matches[index];
      const division = divisions.find((item) => item.id === match.divisionId);
      const home = division?.teams.find((team) => team.id === match.homeTeamId)?.name;
      const away = division?.teams.find((team) => team.id === match.awayTeamId)?.name;
      return { divisionId: match.divisionId, divisionName: division?.name ?? '', homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
        homeName: home ?? '', awayName: away ?? '', round: match.round, stage: match.stage, reason, message: new SchedulePlacementError(match, plan.games.length, matches.length, reason).withTeamNames(home, away) };
    });
    // When nothing fits, the settings are the problem; explain that instead of listing every game.
    if (!plan.games.length && unplaced.length) throw new BadRequestException(`${unplaced[0].divisionName || 'Division'}: ${unplaced[0].message}`);
    const games = plan.games.map(({ index, game }) => ({ ...game, round: matches[index].round, divisionId: matches[index].divisionId }));
    return { games, unplaced: unplaced.map(({ message: _message, ...item }) => item) };
  }

  async previewSeason(user: string, seasonId: string, input: ScheduleAvailabilityRequestDto | SchedulePreviewDto, mode: 'preliminary' | 'playoffs') {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input, mode);
    const existing = await this.existing(this.db, season.leagueId);
    const { games, unplaced } = this.seasonPlacement(plan.matches, input.availability, existing, plan.included, mode);
    const names = new Map(plan.included.flatMap((division) => division.teams.map((team) => [team.id, team.name] as const)));
    const divisionNames = new Map(plan.included.map((division) => [division.id, division.name]));
    return { games: games.map((game) => ({ ...game, homeName: names.get(game.homeTeamId), awayName: names.get(game.awayTeamId), divisionName: divisionNames.get(game.divisionId) })),
      unplaced, warnings: this.warnings(games, plan.included[0].context, input.availability.timeZone), divisions: plan.details };
  }

  async estimateSeason(user: string, seasonId: string, input: ScheduleAvailabilityRequestDto | SchedulePreviewDto, mode: 'preliminary' | 'playoffs') {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input, mode, true);
    const existing = await this.existing(this.db, season.leagueId);
    const capacity = this.trySchedule(() => estimateCourtCapacity(input.availability, existing));
    return { capacity, required: plan.matches.length, divisions: plan.details.map((division) => ({ ...division, gameCount: plan.matches.filter((match) => match.divisionId === division.id).length })) };
  }

  async validateSeason(user: string, seasonId: string, input: SeasonScheduleSaveDto | SeasonPlayoffSaveDto, mode: 'preliminary' | 'playoffs') {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input, mode);
    const expectedIds = plan.included.map((division) => division.id).sort();
    const submittedIds = [...input.divisionIds].sort();
    if (expectedIds.length !== submittedIds.length || expectedIds.some((id, index) => id !== submittedIds[index])) throw new BadRequestException('Eligible divisions changed; generate a new preview');
    for (const division of plan.included) this.partOfMatches(plan.matches.filter((match) => match.divisionId === division.id), input.games.filter((game) => game.divisionId === division.id));
    if (input.games.some((game) => !expectedIds.includes(game.divisionId))) throw new BadRequestException('The schedule has changed; generate a new preview');
    const existing = await this.existing(this.db, season.leagueId);
    const issues = this.trySchedule(() => scheduleIssues(mode === 'playoffs' ? input.games.map((game) => ({ ...game, round: 1 })) : input.games, input.availability, existing));
    const ids = [...new Set(issues.flatMap((issue) => issue.with?.kind === 'existing' ? [issue.with.id] : []))];
    return { issues, existingGames: await this.existingDetails(season.leagueId, ids) };
  }

  // Names, time and place of existing games that a draft conflicts with, so the organizer can see what is in the way.
  private async existingDetails(leagueId: string, ids: string[]) {
    if (!ids.length) return [];
    const games = await this.db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id')
      .leftJoin('league.venues as v', 'v.id', 'g.venue_id')
      .select(['g.id', 'g.scheduled_at', 'g.duration_minutes', 'g.venue_id', 'v.name as venueName', 'ht.name as homeName', 'at.name as awayName', 'd.name as divisionName'])
      .where('s.league_id', '=', leagueId).where('g.id', 'in', ids).execute();
    return games.map((game) => ({ id: game.id, scheduledAt: new Date(game.scheduled_at!).toISOString(), durationMinutes: game.duration_minutes,
      venueId: game.venue_id, venueName: game.venueName, homeName: game.homeName, awayName: game.awayName, divisionName: game.divisionName }));
  }

  async calendarSeason(user: string, seasonId: string, input: ScheduleAvailabilityRequestDto) {
    const season = await this.seasonContext(user, seasonId, this.db);
    await this.validateVenues(this.db, season.leagueId, input.availability);
    // The two-day margin includes all IANA offsets and games crossing a date boundary.
    const start = new Date(Date.parse(`${input.availability.startDate}T00:00:00Z`) - 2 * 86400000);
    const end = new Date(Date.parse(`${input.availability.endDate}T00:00:00Z`) + 3 * 86400000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() - start.getTime() > 371 * 86400000 || end <= start) throw new BadRequestException('Invalid date range');
    const games = await this.db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id')
      .select(['g.id', 'g.scheduled_at', 'g.duration_minutes', 'g.venue_id', 'ht.name as homeName', 'at.name as awayName', 'd.name as divisionName'])
      .where('s.league_id', '=', season.leagueId).where('g.venue_id', 'in', input.availability.venueIds)
      .where('g.scheduled_at', '>=', start).where('g.scheduled_at', '<', end).limit(10001).execute();
    if (games.length > 10000) throw new BadRequestException('Too many existing games to display. Shorten the date range.');
    return { games: games.map((game) => ({ id: game.id, scheduledAt: new Date(game.scheduled_at!).toISOString(), durationMinutes: game.duration_minutes ?? input.availability.durationMinutes, venueId: game.venue_id, homeName: game.homeName, awayName: game.awayName, divisionName: game.divisionName })) };
  }

  async saveSeason(user: string, seasonId: string, input: SeasonScheduleSaveDto | SeasonPlayoffSaveDto, mode: 'preliminary' | 'playoffs') {
    return this.db.transaction().execute(async (tx) => {
      const season = await this.seasonContext(user, seasonId, tx, true);
      await this.leagueLock(tx, season.leagueId);
      const plan = await this.seasonPlan(tx, season, input, mode);
      const expectedIds = plan.included.map((division) => division.id).sort();
      const submittedIds = [...input.divisionIds].sort();
      if (expectedIds.length !== submittedIds.length || expectedIds.some((id, index) => id !== submittedIds[index])) throw new BadRequestException('Eligible divisions changed; generate a new preview');
      for (const division of plan.included) this.sameMatches(plan.matches.filter((match) => match.divisionId === division.id), input.games.filter((game) => game.divisionId === division.id));
      if (input.games.some((game) => !expectedIds.includes(game.divisionId))) throw new BadRequestException('The schedule has changed; generate a new preview');
      const existing = await this.existing(tx, season.leagueId);
      this.trySchedule(() => validateSchedule(mode === 'playoffs' ? input.games.map((game) => ({ ...game, round: 1 })) : input.games, input.availability, existing));
      for (const division of plan.included) {
        let scheduleId = division.playoff?.schedule.id;
        if (mode === 'preliminary') {
          const settings = input as SeasonScheduleSaveDto;
          const playoffs = settings.playoffs && division.teamCount >= 4;
          const schedule = await tx.insertInto('league.division_schedules').values({ division_id: division.id, format: settings.format, playoffs,
            third_place: playoffs && settings.thirdPlace, team_ids: division.teams.map((team) => team.id) }).returning('id').executeTakeFirstOrThrow();
          scheduleId = schedule.id;
        }
        if (!scheduleId) throw new BadRequestException('The playoff schedule changed; generate a new preview');
        await this.insert(tx, division.context, scheduleId, input.games.filter((game) => game.divisionId === division.id));
      }
      return { saved: input.games.length };
    });
  }

  async preview(user: string, divisionId: string, input: SchedulePreviewDto) {
    const context = await this.context(user, divisionId, this.db);
    const { teams, matches } = await this.preliminary(this.db, context, input);
    const existing = await this.existing(this.db, context.leagueId);
    const games = this.trySchedule(() => scheduleMatches(matches, input.availability, existing), teams);
    return { games: this.withNames(games, teams), warnings: this.warnings(games, context, input.availability.timeZone) };
  }

  async save(user: string, divisionId: string, input: ScheduleSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const context = await this.context(user, divisionId, tx, true);
      await this.leagueLock(tx, context.leagueId);
      const { teams, matches } = await this.preliminary(tx, context, input);
      this.sameMatches(matches, input.games);
      const existing = await this.existing(tx, context.leagueId);
      this.trySchedule(() => validateSchedule(input.games, input.availability, existing));
      const schedule = await tx.insertInto('league.division_schedules').values({ division_id: divisionId, format: input.format,
        playoffs: input.playoffs, third_place: input.thirdPlace, team_ids: teams.map((team) => team.id) }).returning('id').executeTakeFirstOrThrow();
      await this.insert(tx, context, schedule.id, input.games);
      return { saved: input.games.length };
    });
  }

  private async playoffMatches(db: Database, context: DivisionContext) {
    this.editable(context);
    const [schedule, teams, games] = await Promise.all([
      db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', context.divisionId).executeTakeFirst(),
      this.teams(db, context.divisionId),
      db.selectFrom('league.games').selectAll().where('division_id', '=', context.divisionId).execute(),
    ]);
    if (!schedule?.playoffs) throw new BadRequestException('Playoffs were not enabled for this schedule');
    if (teams.length !== schedule.team_ids.length || teams.some((team) => !schedule.team_ids.includes(team.id))) throw new BadRequestException('Division teams changed since the schedule was generated');
    const preliminary = games.filter((game) => game.stage === 'preliminary');
    const expected = roundRobin(schedule.team_ids, schedule.format as 'single' | 'double');
    const generated = preliminary.filter((game) => game.schedule_id === schedule.id);
    this.sameMatches(expected, generated.map((game) => ({ homeTeamId: game.home_season_team_id, awayTeamId: game.away_season_team_id,
      round: game.round ?? 0, stage: 'preliminary', scheduledAt: '', venueId: '', durationMinutes: 1 })));
    if (preliminary.some((game) => game.status !== 'completed')) throw new BadRequestException('Complete all preliminary games before generating playoffs');
    const semifinals = games.filter((game) => game.stage === 'semifinal');
    let matches: ScheduleMatch[];
    if (!semifinals.length) {
      const standings = calculateStandings(teams, preliminary.map((game) => ({ homeId: game.home_season_team_id, awayId: game.away_season_team_id, homeScore: game.home_score!, awayScore: game.away_score! })));
      matches = [ { homeTeamId: standings[0].id, awayTeamId: standings[3].id, round: 1, stage: 'semifinal' },
        { homeTeamId: standings[1].id, awayTeamId: standings[2].id, round: 1, stage: 'semifinal' } ];
    } else {
      if (semifinals.length !== 2 || semifinals.some((game) => game.status !== 'completed')) throw new BadRequestException('Complete both semifinals before generating the final');
      if (games.some((game) => game.stage === 'final' || game.stage === 'third_place')) throw new BadRequestException('Remove existing final-round games before generating them again');
      semifinals.sort((a, b) => a.id.localeCompare(b.id));
      const winner = (game: typeof semifinals[number]) => game.home_score! > game.away_score! ? game.home_season_team_id : game.away_season_team_id;
      const loser = (game: typeof semifinals[number]) => game.home_score! > game.away_score! ? game.away_season_team_id : game.home_season_team_id;
      matches = [{ homeTeamId: winner(semifinals[0]), awayTeamId: winner(semifinals[1]), round: 2, stage: 'final' }];
      if (schedule.third_place) matches.push({ homeTeamId: loser(semifinals[0]), awayTeamId: loser(semifinals[1]), round: 2, stage: 'third_place' });
    }
    return { teams, matches, schedule };
  }

  async previewPlayoffs(user: string, divisionId: string, input: ScheduleAvailabilityRequestDto) {
    const context = await this.context(user, divisionId, this.db);
    const { teams, matches } = await this.playoffMatches(this.db, context);
    await this.validateVenues(this.db, context.leagueId, input.availability);
    this.checkTeamAvailability(input.availability, teams.map((team) => team.id));
    const existing = await this.existing(this.db, context.leagueId);
    const games = this.trySchedule(() => scheduleMatches(matches, input.availability, existing), teams);
    return { games: this.withNames(games, teams), warnings: this.warnings(games, context, input.availability.timeZone) };
  }

  async savePlayoffs(user: string, divisionId: string, input: PlayoffSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const context = await this.context(user, divisionId, tx, true);
      await this.leagueLock(tx, context.leagueId);
      const { teams, matches, schedule } = await this.playoffMatches(tx, context);
      await this.validateVenues(tx, context.leagueId, input.availability);
      this.checkTeamAvailability(input.availability, teams.map((team) => team.id));
      this.sameMatches(matches, input.games);
      const existing = await this.existing(tx, context.leagueId);
      this.trySchedule(() => validateSchedule(input.games, input.availability, existing));
      await this.insert(tx, context, schedule.id, input.games);
      return { saved: input.games.length };
    });
  }

  private async insert(tx: Transaction<DB>, context: DivisionContext, scheduleId: string, games: ScheduleGame[]) {
    await tx.insertInto('league.games').values(games.map((game) => ({ season_id: context.seasonId, division_id: context.divisionId,
      home_season_team_id: game.homeTeamId, away_season_team_id: game.awayTeamId, scheduled_at: new Date(game.scheduledAt),
      venue_id: game.venueId, duration_minutes: game.durationMinutes, stage: game.stage, round: game.round, schedule_id: scheduleId }))).execute();
  }

  async remove(user: string, gameId: string) {
    return this.db.transaction().execute(async (tx) => {
      const first = await tx.selectFrom('league.games').select(['division_id']).where('id', '=', gameId).executeTakeFirst();
      if (!first) throw new NotFoundException();
      const context = await this.context(user, first.division_id, tx, true);
      await this.leagueLock(tx, context.leagueId);
      this.editable(context);
      const game = await tx.selectFrom('league.games').selectAll().where('id', '=', gameId).executeTakeFirst();
      if (!game) throw new NotFoundException();
      if (game.status !== 'scheduled') throw new BadRequestException('Only unplayed scheduled games can be removed');
      const stats = await tx.selectFrom('league.player_game_stats').select('id').where('game_id', '=', gameId).executeTakeFirst();
      if (stats) throw new BadRequestException('Games with dependent records cannot be removed');
      if (game.stage === 'preliminary' || game.stage === 'semifinal') {
        const later = await tx.selectFrom('league.games').select('id').where('division_id', '=', context.divisionId)
          .where('stage', 'in', game.stage === 'preliminary' ? ['semifinal', 'final', 'third_place'] : ['final', 'third_place']).executeTakeFirst();
        if (later) throw new BadRequestException('Remove dependent playoff games first');
      }
      await tx.deleteFrom('league.games').where('id', '=', gameId).execute();
      if (game.schedule_id) {
        const remaining = await tx.selectFrom('league.games').select('id').where('schedule_id', '=', game.schedule_id).executeTakeFirst();
        if (!remaining) await tx.deleteFrom('league.division_schedules').where('id', '=', game.schedule_id).execute();
      }
      return { deleted: true };
    });
  }
}
