import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import { ensureNotArchived } from '../common/request-scope';
import type { DB } from '../database/db';
import { PlayoffOptionsDto, PlayoffSaveDto, ScheduleAvailabilityRequestDto, SchedulePreviewDto, ScheduleSaveDto, SeasonSchedulePreviewDto, SeasonScheduleSaveDto, SeasonScheduleSuggestDto } from './league.dto';
import { estimateCourtCapacity, planSchedule, teamGameCapacity, roundRobin, scheduleIssues, scheduleMatches, SchedulePlacementError, suggestSlots, validateSchedule, type ExistingGame, type ScheduleAvailability, type ScheduleGame, type ScheduleIssue, type ScheduleMatch } from './schedule-algorithm';
import { calculateStandings } from './standings';
import { bracketSlot, labelPending, parseBracketSlot, parseSavedSlot, parseSeedSlot, pendingLabel, seedLabel, seedSlot } from './bracket';

type Database = Kysely<DB> | Transaction<DB>;
type DivisionContext = Awaited<ReturnType<ScheduleService['context']>>;
type Named = { id: string; name: string };

const calendarDateFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

function calendarDate(formatter: Intl.DateTimeFormat, instant: Date): string {
  const parts = formatter.formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

@Injectable()
export class ScheduleService {
  constructor(private readonly database: DatabaseService) {}
  private get db() { return this.database.db; }

  private async context(user: string, divisionId: string, db: Database, lock = false) {
    let query = db.selectFrom('league.divisions as d')
      .innerJoin('league.seasons as s', 's.id', 'd.season_id')
      .innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['d.id as divisionId', 's.id as seasonId', 's.league_id as leagueId', 'l.time_zone as leagueTimeZone', 's.status',
        sql<string | null>`s.start_date::text`.as('startDate'), sql<string | null>`s.end_date::text`.as('endDate')])
      .where('d.id', '=', divisionId).where('o.owner_user_id', '=', user);
    if (lock) query = query.forUpdate('s');
    const found = await query.select(['s.archived_at as seasonArchivedAt', 'l.archived_at as leagueArchivedAt', 'o.archived_at as organizationArchivedAt']).executeTakeFirst();
    if (!found) throw new NotFoundException();
    const { seasonArchivedAt, leagueArchivedAt, organizationArchivedAt, ...context } = found;
    ensureNotArchived(seasonArchivedAt, leagueArchivedAt, organizationArchivedAt);
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

  private async lastPreliminaryGameAt(db: Database, seasonId: string) {
    const { latest } = await db.selectFrom('league.games').select((eb) => eb.fn.max<Date | null>('scheduled_at').as('latest'))
      .where('season_id', '=', seasonId).where('stage', '=', 'preliminary').executeTakeFirstOrThrow();
    return latest;
  }

  private async validatePlayoffDates(db: Database, season: Pick<DivisionContext, 'seasonId' | 'leagueTimeZone'>, availability: ScheduleAvailability) {
    const latest = await this.lastPreliminaryGameAt(db, season.seasonId);
    if (!latest) return;
    const formatter = this.trySchedule(() => calendarDateFormatter(availability.timeZone));
    if (season.leagueTimeZone && formatter.resolvedOptions().timeZone !== calendarDateFormatter(season.leagueTimeZone).resolvedOptions().timeZone) {
      throw new BadRequestException('Use the league time zone when scheduling playoffs');
    }
    const lastDate = calendarDate(formatter, latest);
    if (availability.startDate <= lastDate || availability.endDate <= lastDate) {
      throw new BadRequestException(`Playoff dates must be after the last elimination game on ${lastDate}`);
    }
  }

  // Only games near the selected dates can conflict. The margin covers time-zone offsets, game length and the 7-day pacing rule.
  private async existing(db: Database, leagueId: string, availability?: ScheduleAvailability): Promise<ExistingGame[]> {
    let query = db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .select(['g.id', 'g.division_id', 'g.stage', 'g.home_season_team_id', 'g.away_season_team_id', 'g.home_seed', 'g.away_seed', 'g.home_source_game_id', 'g.home_source_outcome',
        'g.away_source_game_id', 'g.away_source_outcome', 'g.scheduled_at', 'g.venue_id', 'g.duration_minutes'])
      .where('s.league_id', '=', leagueId).where('g.scheduled_at', 'is not', null);
    const from = Date.parse(`${availability?.startDate}T00:00:00Z`) - 8 * 86400000;
    const to = Date.parse(`${availability?.endDate}T00:00:00Z`) + 9 * 86400000;
    if (Number.isFinite(from) && Number.isFinite(to)) query = query.where('g.scheduled_at', '>=', new Date(from)).where('g.scheduled_at', '<', new Date(to));
    const games = await query.execute();
    // A side still waiting stands in as its seed, or as a semifinal's winner or loser, which the semifinal also counts for.
    const side = (team: string | null, seed: number | null, divisionId: string, source: string | null, outcome: string | null) =>
      team ?? (seed ? seedSlot(divisionId, seed) : source + ':' + outcome);
    return games.map((game) => ({ id: game.id,
      homeTeamId: side(game.home_season_team_id, game.home_seed, game.division_id, game.home_source_game_id, game.home_source_outcome),
      awayTeamId: side(game.away_season_team_id, game.away_seed, game.division_id, game.away_source_game_id, game.away_source_outcome),
      ...(game.stage === 'semifinal' ? { aliases: [game.id + ':winner', game.id + ':loser'], round: 0 } : {}),
      scheduledAt: new Date(game.scheduled_at!).toISOString(), venueId: game.venue_id, durationMinutes: game.duration_minutes }));
  }

  private checkTeamAvailability(availability: ScheduleAvailability, teamIds: Iterable<string>) {
    const allowed = new Set(teamIds);
    if (availability?.teamUnavailability?.some((entry) => !allowed.has(entry.teamId))) throw new BadRequestException('Team availability includes a team outside this schedule');
  }

  private warnings(games: ScheduleGame[], context: DivisionContext, zone: string) {
    const formatter = calendarDateFormatter(zone);
    const outside = games.some((game) => {
      const date = calendarDate(formatter, new Date(game.scheduledAt));
      return (context.startDate && date < context.startDate) || (context.endDate && date > context.endDate);
    });
    return outside ? ['Some games are outside the season dates.'] : [];
  }

  private withNames(games: ScheduleGame[], teams: Named[]) {
    const names = new Map(teams.map((team) => [team.id, team.name]));
    return games.map((game) => ({ ...game, homeName: names.get(game.homeTeamId) ?? '', awayName: names.get(game.awayTeamId) ?? '' }));
  }

  // Drafts come back from the browser without stand-ins, so semifinals get theirs again from the expected fixtures.
  private withAliases<T extends ScheduleMatch>(games: T[], matches: ScheduleMatch[]): T[] {
    const key = (match: ScheduleMatch) => [match.stage, match.round, match.homeTeamId, match.awayTeamId].join(':');
    const aliases = new Map(matches.filter((match) => match.aliases?.length).map((match) => [key(match), match.aliases!]));
    return games.map((game) => aliases.has(key(game)) ? { ...game, aliases: aliases.get(key(game)) } : game);
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

  private trySchedule<T>(fn: () => T, teams: Named[] = []): T {
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
    const [schedule, games, teams] = await Promise.all([
      this.db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', divisionId).executeTakeFirst(),
      this.db.selectFrom('league.games').select(['stage', 'status']).where('division_id', '=', divisionId).execute(),
      this.teams(this.db, divisionId),
    ]);
    const prelim = games.filter((game) => game.stage === 'preliminary');
    const semifinals = games.filter((game) => game.stage === 'semifinal');
    let playoffStage: 'semifinal' | 'final' | null = null;
    if (schedule && teams.length >= 4 && prelim.length) {
      if (!semifinals.length) playoffStage = 'semifinal';
      else if (semifinals.length === 2 && !games.some((game) => game.stage === 'final' || game.stage === 'third_place')) playoffStage = 'final';
    }
    return { hasSchedule: !!schedule, canGeneratePreliminary: context.status !== 'completed' && !schedule && !prelim.length,
      playoffStage: context.status === 'completed' ? null : playoffStage, playoffs: !!schedule?.playoffs, thirdPlace: !!schedule?.third_place };
  }

  private async seasonContext(user: string, seasonId: string, db: Database, lock = false) {
    let query = db.selectFrom('league.seasons as s').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['s.id as seasonId', 's.league_id as leagueId', 'l.time_zone as leagueTimeZone', 's.status', sql<string | null>`s.start_date::text`.as('startDate'), sql<string | null>`s.end_date::text`.as('endDate')])
      .where('s.id', '=', seasonId).where('o.owner_user_id', '=', user);
    if (lock) query = query.forUpdate('s');
    const found = await query.select(['s.archived_at as seasonArchivedAt', 'l.archived_at as leagueArchivedAt', 'o.archived_at as organizationArchivedAt']).executeTakeFirst();
    if (!found) throw new NotFoundException();
    const { seasonArchivedAt, leagueArchivedAt, organizationArchivedAt, ...season } = found;
    ensureNotArchived(seasonArchivedAt, leagueArchivedAt, organizationArchivedAt);
    return season;
  }

  private async seasonDivisions(db: Database, season: Awaited<ReturnType<ScheduleService['seasonContext']>>, thirdPlace?: boolean) {
    const divisions = await db.selectFrom('league.divisions').select(['id', 'name']).where('season_id', '=', season.seasonId).orderBy('name').orderBy('id').execute();
    return Promise.all(divisions.map(async (division) => {
      const context = { ...season, divisionId: division.id };
      const [teams, schedule, games] = await Promise.all([
        this.teams(db, division.id),
        db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', division.id).executeTakeFirst(),
        db.selectFrom('league.games').select(['stage', 'status']).where('division_id', '=', division.id).execute(),
      ]);
      let playoff: Awaited<ReturnType<ScheduleService['playoffMatches']>> | null = null;
      let playoffReason = !schedule ? 'Generate the round robin first.' : 'Complete the previous round before scheduling playoffs.';
      if (schedule && season.status !== 'completed') {
        try { playoff = await this.playoffMatches(db, context, thirdPlace); }
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
        preliminaryReason, playoffReason: playoff ? undefined : playoffReason, context, teams, labels: playoff?.labels ?? teams, playoff };
    }));
  }

  async seasonStatus(user: string, seasonId: string) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const [divisions, latest] = await Promise.all([this.seasonDivisions(this.db, season), this.lastPreliminaryGameAt(this.db, seasonId)]);
    return { lastPreliminaryGameAt: latest?.toISOString() ?? null,
      divisions: divisions.map(({ context: _context, playoff: _playoff, labels: _labels, ...division }) => division) };
  }

  // One generation covers the round robin and, when requested, each division's playoff bracket. A division whose round robin
  // already exists gets only its bracket. Bracket games use their own dates after the round robin and take the earliest open slots.
  private async seasonPlan(db: Database, season: Awaited<ReturnType<ScheduleService['seasonContext']>>, input: SchedulePreviewDto, allowEmpty = false) {
    if (season.status === 'completed') throw new BadRequestException('Completed seasons cannot be changed');
    if (input.thirdPlace && !input.playoffs) throw new BadRequestException('A third-place game requires playoffs');
    await this.validateVenues(db, season.leagueId, input.availability);
    const divisions = await this.seasonDivisions(db, season, input.playoffs ? !!input.thirdPlace : undefined);
    this.checkTeamAvailability(input.availability, divisions.flatMap((division) => division.teams.map((team) => team.id)));
    const planned = divisions.map((division) => {
      const fixtures = division.canGeneratePreliminary ? roundRobin(division.teams.map((team) => team.id), input.format) : [];
      let bracket: { matches: ScheduleMatch[]; labels: Named[] } | null = null;
      if (input.playoffs && division.canGeneratePreliminary && division.teamCount >= 4) bracket = this.bracket(division.id, this.seeds(division.id), !!input.thirdPlace);
      else if (input.playoffs && !division.canGeneratePreliminary && division.playoff) bracket = division.playoff;
      return { ...division, fixtures, bracket, labels: [...division.teams, ...(bracket?.labels ?? [])] };
    });
    const included = planned.filter((division) => division.fixtures.length || division.bracket);
    const details = planned.map((division) => {
      const reason = included.includes(division) ? undefined : input.playoffs && division.hasSchedule ? division.playoffReason : division.preliminaryReason;
      return { id: division.id, name: division.name, teamCount: division.teamCount, ...(reason ? { reason } : {}),
        roundRobin: division.fixtures.length > 0, playoffs: !!division.bracket,
        ...(input.playoffs && division.fixtures.length && !division.bracket ? { notice: 'Fewer than four teams; round robin only.' } : {}) };
    });
    if (!included.length && !allowEmpty) throw new BadRequestException(input.playoffs ? 'No divisions are ready for a round robin or playoffs.' : 'No divisions are eligible for schedule generation.');
    const tagged = (division: (typeof included)[number], matches: ScheduleMatch[]) => matches.map((match) => ({ ...match, divisionId: division.id, groupId: division.id }));
    const preliminary = included.flatMap((division) => tagged(division, division.fixtures));
    const playoff = included.flatMap((division) => tagged(division, division.bracket?.matches ?? []));
    if (preliminary.length + playoff.length > 5000) throw new BadRequestException('This schedule exceeds the 5,000-game batch limit.');
    let playoffAvailability: ScheduleAvailability | undefined;
    if (playoff.length) {
      if (!input.playoffDates) throw new BadRequestException('Choose playoff dates');
      playoffAvailability = { ...input.availability, ...input.playoffDates, pace: 'compact' };
      await this.validatePlayoffDates(db, season, playoffAvailability);
      if (preliminary.length && input.playoffDates.startDate <= input.availability.endDate) {
        throw new BadRequestException(`Playoff dates must be after the round robin ends on ${input.availability.endDate}`);
      }
    }
    return { included, details, preliminary, playoff, matches: [...preliminary, ...playoff], playoffAvailability };
  }

  // Round-robin games use the main dates and bracket games the playoff dates, so each group is checked against its own availability.
  private stageGroups<T extends { stage: string }>(games: T[], availability: ScheduleAvailability, playoffAvailability?: ScheduleAvailability) {
    const entries = games.map((game, index) => ({ game, index }));
    const preliminary = entries.filter(({ game }) => game.stage === 'preliminary');
    const playoff = entries.filter(({ game }) => game.stage !== 'preliminary');
    if (playoff.length && !playoffAvailability) throw new BadRequestException('The schedule has changed; generate a new preview');
    return [{ entries: preliminary, availability }, { entries: playoff, availability: playoffAvailability! }].filter((group) => group.entries.length);
  }

  private seasonPlacement(matches: (ScheduleMatch & { divisionId: string })[], availability: ScheduleAvailability, existing: ExistingGame[], divisions: { id: string; name: string; labels: Named[] }[], mode: 'preliminary' | 'playoffs', pinned: (ScheduleGame & { divisionId: string })[] = []) {
    // Pinned games keep their time and venue; they must be expected fixtures, each used once.
    const key = (match: ScheduleMatch & { divisionId: string }) => [match.divisionId, match.stage, match.round, match.homeTeamId, match.awayTeamId].join(':');
    const pool = new Map<string, (ScheduleGame & { divisionId: string })[]>();
    for (const game of pinned) {
      if (!availability.venueIds.includes(game.venueId) || game.durationMinutes !== availability.durationMinutes) throw new BadRequestException('Kept games must use the selected venues and game duration');
      pool.set(key(game), [...(pool.get(key(game)) ?? []), game]);
    }
    const kept = new Map<number, ScheduleGame & { divisionId: string }>();
    const open: number[] = [];
    matches.forEach((match, index) => {
      const game = pool.get(key(match))?.shift();
      if (game) kept.set(index, game); else open.push(index);
    });
    if ([...pool.values()].some((games) => games.length)) throw new BadRequestException('The schedule has changed; generate a new preview');
    // Playoff divisions can be at different stages, so each one's rounds count from its own first round.
    const firstRound = new Map<string, number>();
    for (const match of matches) firstRound.set(match.divisionId, Math.min(firstRound.get(match.divisionId) ?? match.round, match.round));
    const round = (item: { round: number; divisionId: string }) => mode === 'playoffs' ? item.round - (firstRound.get(item.divisionId) ?? 1) + 1 : item.round;
    const toPlace = open.map((index) => matches[index]);
    const fixed = [...kept.entries()].map(([index, game]) => ({ homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId, stage: game.stage, aliases: matches[index].aliases,
      scheduledAt: game.scheduledAt, venueId: game.venueId, durationMinutes: game.durationMinutes, round: round(matches[index]) }));
    const plan = this.trySchedule(() => planSchedule(toPlace.map((match) => ({ ...match, round: round(match) })), availability, existing, fixed));
    const unplaced = plan.unplaced.map(({ index, reason, code }) => {
      const match = toPlace[index];
      const division = divisions.find((item) => item.id === match.divisionId);
      const home = division?.labels.find((team) => team.id === match.homeTeamId)?.name;
      const away = division?.labels.find((team) => team.id === match.awayTeamId)?.name;
      return { divisionId: match.divisionId, divisionName: division?.name ?? '', homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
        homeName: home ?? '', awayName: away ?? '', round: match.round, stage: match.stage, reason, reasonCode: code, message: new SchedulePlacementError(match, plan.games.length, matches.length, reason).withTeamNames(home, away) };
    });
    // When nothing fits, the settings are the problem; explain that instead of listing every game.
    if (!plan.games.length && !kept.size && unplaced.length) throw new BadRequestException(`${unplaced[0].divisionName || 'Division'}: ${unplaced[0].message}`);
    const placed = new Map(plan.games.map(({ index, game }) => [open[index], game]));
    const games = matches.flatMap((match, index) => {
      const game = kept.get(index) ?? placed.get(index);
      return game ? [{ homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId, stage: game.stage, scheduledAt: game.scheduledAt, venueId: game.venueId,
        durationMinutes: game.durationMinutes, round: match.round, divisionId: match.divisionId }] : [];
    });
    return { games, unplaced: unplaced.map(({ message: _message, ...item }) => item) };
  }

  async previewSeason(user: string, seasonId: string, input: SeasonSchedulePreviewDto) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input);
    const pinned = input.pinned ?? [];
    const groups = [
      { matches: plan.preliminary, availability: input.availability, mode: 'preliminary' as const, pinned: pinned.filter((game) => game.stage === 'preliminary') },
      { matches: plan.playoff, availability: plan.playoffAvailability, mode: 'playoffs' as const, pinned: pinned.filter((game) => game.stage !== 'preliminary') },
    ];
    const games: (ScheduleGame & { divisionId: string })[] = [];
    const unplaced: ReturnType<ScheduleService['seasonPlacement']>['unplaced'] = [];
    for (const group of groups) {
      if (!group.matches.length || !group.availability) {
        if (group.pinned.length) throw new BadRequestException('The schedule has changed; generate a new preview');
        continue;
      }
      const existing = await this.existing(this.db, season.leagueId, group.availability);
      const placed = this.seasonPlacement(group.matches, group.availability, existing, plan.included, group.mode, group.pinned);
      games.push(...placed.games);
      unplaced.push(...placed.unplaced);
    }
    const names = new Map(plan.included.flatMap((division) => division.labels.map((team) => [team.id, team.name] as const)));
    const divisionNames = new Map(plan.included.map((division) => [division.id, division.name]));
    return { games: games.map((game) => ({ ...game, homeName: names.get(game.homeTeamId), awayName: names.get(game.awayTeamId), divisionName: divisionNames.get(game.divisionId) })),
      unplaced, warnings: this.warnings(games, plan.included[0].context, input.availability.timeZone), divisions: plan.details };
  }

  async estimateSeason(user: string, seasonId: string, input: SchedulePreviewDto) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input, true);
    const required = plan.preliminary.length;
    let preliminary: { capacity: number; maxGamesPerTeam: number | null; limitedBy: 'weekly' | 'daily' | null } = { capacity: 0, maxGamesPerTeam: null, limitedBy: null };
    if (required) {
      const existing = await this.existing(this.db, season.leagueId, input.availability);
      preliminary = { capacity: this.trySchedule(() => estimateCourtCapacity(input.availability, existing)), ...this.trySchedule(() => teamGameCapacity(input.availability)) };
    }
    let playoffs: { required: number; capacity: number } | null = null;
    if (plan.playoffAvailability) {
      const availability = plan.playoffAvailability;
      const existing = await this.existing(this.db, season.leagueId, availability);
      playoffs = { required: plan.playoff.length, capacity: this.trySchedule(() => estimateCourtCapacity(availability, existing)) };
    }
    // The most round-robin games any one team plays in the division, compared with what pacing and daily limits allow.
    const gamesPerTeam = (divisionId: string) => {
      const counts = new Map<string, number>();
      for (const match of plan.preliminary) if (match.divisionId === divisionId) for (const team of [match.homeTeamId, match.awayTeamId]) counts.set(team, (counts.get(team) ?? 0) + 1);
      return Math.max(0, ...counts.values());
    };
    return { ...preliminary, required, playoffs, divisions: plan.details.map((division) => ({ ...division,
      gameCount: plan.preliminary.filter((match) => match.divisionId === division.id).length,
      playoffGameCount: plan.playoff.filter((match) => match.divisionId === division.id).length, gamesPerTeam: gamesPerTeam(division.id) })) };
  }

  async validateSeason(user: string, seasonId: string, input: SeasonScheduleSaveDto) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input);
    const expectedIds = plan.included.map((division) => division.id).sort();
    const submittedIds = [...input.divisionIds].sort();
    if (expectedIds.length !== submittedIds.length || expectedIds.some((id, index) => id !== submittedIds[index])) throw new BadRequestException('Eligible divisions changed; generate a new preview');
    for (const division of plan.included) this.partOfMatches(plan.matches.filter((match) => match.divisionId === division.id), input.games.filter((game) => game.divisionId === division.id));
    if (input.games.some((game) => !expectedIds.includes(game.divisionId))) throw new BadRequestException('The schedule has changed; generate a new preview');
    const issues: ScheduleIssue[] = [];
    for (const group of this.stageGroups(input.games, input.availability, plan.playoffAvailability)) {
      const existing = await this.existing(this.db, season.leagueId, group.availability);
      const found = this.trySchedule(() => scheduleIssues(this.withAliases(group.entries.map(({ game }) => game), plan.matches), group.availability, existing));
      const original = (position: number) => group.entries[position].index;
      issues.push(...found.map((issue) => ({ ...issue, index: original(issue.index), ...(issue.with?.kind === 'draft' ? { with: { kind: 'draft' as const, index: original(issue.with.index) } } : {}) })));
    }
    const ids = [...new Set(issues.flatMap((issue) => issue.with?.kind === 'existing' ? [issue.with.id] : []))];
    return { issues, existingGames: await this.existingDetails(season.leagueId, ids) };
  }

  // Names, time and place of existing games that a draft conflicts with, so the organizer can see what is in the way.
  private async existingDetails(leagueId: string, ids: string[]) {
    if (!ids.length) return [];
    const games = await this.db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .leftJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').leftJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .leftJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').leftJoin('league.teams as at', 'at.id', 'a.team_id')
      .leftJoin('league.venues as v', 'v.id', 'g.venue_id')
      .select(['g.id', 'g.scheduled_at', 'g.duration_minutes', 'g.venue_id', 'v.name as venueName', 'ht.name as home_name', 'at.name as away_name', 'd.name as divisionName',
        'g.home_seed', 'g.away_seed', 'g.home_source_game_id', 'g.home_source_outcome', 'g.away_source_game_id', 'g.away_source_outcome'])
      .where('s.league_id', '=', leagueId).where('g.id', 'in', ids).execute().then((rows) => labelPending(this.db, rows));
    return games.map((game) => ({ id: game.id, scheduledAt: new Date(game.scheduled_at!).toISOString(), durationMinutes: game.duration_minutes,
      venueId: game.venue_id, venueName: game.venueName, homeName: game.home_name, awayName: game.away_name, divisionName: game.divisionName }));
  }

  async suggestSeason(user: string, seasonId: string, input: SeasonScheduleSuggestDto) {
    const season = await this.seasonContext(user, seasonId, this.db);
    const plan = await this.seasonPlan(this.db, season, input);
    const expectedIds = plan.included.map((division) => division.id).sort();
    const submittedIds = [...input.divisionIds].sort();
    if (expectedIds.length !== submittedIds.length || expectedIds.some((id, index) => id !== submittedIds[index])) throw new BadRequestException('Eligible divisions changed; generate a new preview');
    const { index, game } = input.target;
    if ((index === undefined) === (game === undefined)) throw new BadRequestException('Choose either a draft game or an unplaced game');
    if (index !== undefined && index >= input.games.length) throw new BadRequestException('The schedule has changed; generate a new preview');
    const target = index !== undefined ? input.games[index] : game!;
    const all = index !== undefined ? input.games : [...input.games, { ...game!, scheduledAt: '', venueId: '', durationMinutes: input.availability.durationMinutes }];
    if (all.some((item) => !expectedIds.includes(item.divisionId))) throw new BadRequestException('The schedule has changed; generate a new preview');
    for (const division of plan.included) this.partOfMatches(plan.matches.filter((match) => match.divisionId === division.id), all.filter((item) => item.divisionId === division.id));
    // A game is suggested slots within its own group's dates, around the other games of that group.
    const playoffTarget = target.stage !== 'preliminary';
    const availability = playoffTarget ? plan.playoffAvailability : input.availability;
    if (!availability) throw new BadRequestException('The schedule has changed; generate a new preview');
    const others = input.games.filter((item, position) => position !== index && (item.stage !== 'preliminary') === playoffTarget);
    const existing = await this.existing(this.db, season.leagueId, availability);
    const [match] = this.withAliases<ScheduleMatch>([{ homeTeamId: target.homeTeamId, awayTeamId: target.awayTeamId, round: target.round, stage: target.stage }], plan.matches);
    const current = index !== undefined ? { at: Date.parse(input.games[index].scheduledAt), venueId: input.games[index].venueId } : undefined;
    const slots = this.trySchedule(() => suggestSlots(match, this.withAliases(others, plan.matches), availability, existing, 4));
    // The game's own slot is not a suggestion.
    return { suggestions: slots.filter((slot) => !current || Date.parse(slot.scheduledAt) !== current.at || slot.venueId !== current.venueId).slice(0, 3) };
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
      .leftJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').leftJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .leftJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').leftJoin('league.teams as at', 'at.id', 'a.team_id')
      .select(['g.id', 'g.scheduled_at', 'g.duration_minutes', 'g.venue_id', 'ht.name as home_name', 'at.name as away_name', 'd.name as divisionName',
        'g.home_seed', 'g.away_seed', 'g.home_source_game_id', 'g.home_source_outcome', 'g.away_source_game_id', 'g.away_source_outcome'])
      .where('s.league_id', '=', season.leagueId).where('g.venue_id', 'in', input.availability.venueIds)
      .where('g.scheduled_at', '>=', start).where('g.scheduled_at', '<', end).limit(10001).execute().then((rows) => labelPending(this.db, rows));
    if (games.length > 10000) throw new BadRequestException('Too many existing games to display. Shorten the date range.');
    return { games: games.map((game) => ({ id: game.id, scheduledAt: new Date(game.scheduled_at!).toISOString(), durationMinutes: game.duration_minutes ?? input.availability.durationMinutes, venueId: game.venue_id, homeName: game.home_name, awayName: game.away_name, divisionName: game.divisionName })) };
  }

  async saveSeason(user: string, seasonId: string, input: SeasonScheduleSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const season = await this.seasonContext(user, seasonId, tx, true);
      await this.leagueLock(tx, season.leagueId);
      const plan = await this.seasonPlan(tx, season, input);
      const expectedIds = plan.included.map((division) => division.id).sort();
      const submittedIds = [...input.divisionIds].sort();
      if (expectedIds.length !== submittedIds.length || expectedIds.some((id, index) => id !== submittedIds[index])) throw new BadRequestException('Eligible divisions changed; generate a new preview');
      for (const division of plan.included) this.sameMatches(plan.matches.filter((match) => match.divisionId === division.id), input.games.filter((game) => game.divisionId === division.id));
      if (input.games.some((game) => !expectedIds.includes(game.divisionId))) throw new BadRequestException('The schedule has changed; generate a new preview');
      for (const group of this.stageGroups(input.games, input.availability, plan.playoffAvailability)) {
        const existing = await this.existing(tx, season.leagueId, group.availability);
        this.trySchedule(() => validateSchedule(this.withAliases(group.entries.map(({ game }) => game), plan.matches), group.availability, existing));
      }
      for (const division of plan.included) {
        let scheduleId = division.playoff?.schedule.id;
        if (division.fixtures.length) {
          const playoffs = !!division.bracket;
          const schedule = await tx.insertInto('league.division_schedules').values({ division_id: division.id, format: input.format, playoffs,
            third_place: playoffs && !!input.thirdPlace, team_ids: division.teams.map((team) => team.id) }).returning('id').executeTakeFirstOrThrow();
          scheduleId = schedule.id;
        }
        if (!scheduleId) throw new BadRequestException('The playoff schedule changed; generate a new preview');
        await this.insert(tx, division.context, scheduleId, input.games.filter((game) => game.divisionId === division.id), [...division.fixtures, ...(division.bracket?.matches ?? [])]);
        if (!division.fixtures.length && division.playoff) await this.recordPlayoffs(tx, scheduleId, division.playoff.thirdPlace);
      }
      return { saved: input.games.length };
    });
  }

  async preview(user: string, divisionId: string, input: SchedulePreviewDto) {
    const context = await this.context(user, divisionId, this.db);
    const { teams, matches } = await this.preliminary(this.db, context, input);
    const existing = await this.existing(this.db, context.leagueId, input.availability);
    const games = this.trySchedule(() => scheduleMatches(matches, input.availability, existing), teams);
    return { games: this.withNames(games, teams), warnings: this.warnings(games, context, input.availability.timeZone) };
  }

  async save(user: string, divisionId: string, input: ScheduleSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const context = await this.context(user, divisionId, tx, true);
      await this.leagueLock(tx, context.leagueId);
      const { teams, matches } = await this.preliminary(tx, context, input);
      this.sameMatches(matches, input.games);
      const existing = await this.existing(tx, context.leagueId, input.availability);
      this.trySchedule(() => validateSchedule(input.games, input.availability, existing));
      const schedule = await tx.insertInto('league.division_schedules').values({ division_id: divisionId, format: input.format,
        playoffs: !!input.playoffs, third_place: !!input.thirdPlace, team_ids: teams.map((team) => team.id) }).returning('id').executeTakeFirstOrThrow();
      await this.insert(tx, context, schedule.id, input.games, []);
      return { saved: input.games.length };
    });
  }

  // Semifinals 1 vs 4 and 2 vs 3 in round 1, then the championship and optional third-place game for their winners and losers.
  private bracket(divisionId: string, seeds: Named[], thirdPlace: boolean) {
    const pairs = [[seeds[0], seeds[3]], [seeds[1], seeds[2]]] as const;
    const slot = (semifinal: 1 | 2, outcome: 'winner' | 'loser') => bracketSlot(divisionId, semifinal, outcome);
    const matches: ScheduleMatch[] = pairs.map(([home, away], index) => ({ homeTeamId: home.id, awayTeamId: away.id, round: 1, stage: 'semifinal' as const,
      aliases: [slot(index ? 2 : 1, 'winner'), slot(index ? 2 : 1, 'loser')] }));
    matches.push({ homeTeamId: slot(1, 'winner'), awayTeamId: slot(2, 'winner'), round: 2, stage: 'final' });
    if (thirdPlace) matches.push({ homeTeamId: slot(1, 'loser'), awayTeamId: slot(2, 'loser'), round: 2, stage: 'third_place' });
    const labels = [...seeds, ...pairs.flatMap(([home, away], index) => (['winner', 'loser'] as const).map((outcome) => ({
      id: slot(index ? 2 : 1, outcome), name: pendingLabel(outcome, home.name, away.name) })))];
    return { matches, labels };
  }

  // Seeds stand in for the top four teams until the final standings decide them.
  private seeds(divisionId: string): Named[] {
    return [1, 2, 3, 4].map((seed) => ({ id: seedSlot(divisionId, seed), name: seedLabel(seed) }));
  }

  // Any division with a generated round robin and at least four teams can schedule playoffs; the third-place choice is made here.
  private async playoffMatches(db: Database, context: DivisionContext, thirdPlaceChoice?: boolean) {
    this.editable(context);
    const [schedule, teams, games] = await Promise.all([
      db.selectFrom('league.division_schedules').selectAll().where('division_id', '=', context.divisionId).executeTakeFirst(),
      this.teams(db, context.divisionId),
      db.selectFrom('league.games').selectAll().where('division_id', '=', context.divisionId).execute(),
    ]);
    if (!schedule) throw new BadRequestException('Generate the round robin before scheduling playoffs');
    if (teams.length < 4) throw new BadRequestException('Playoffs need at least four teams');
    const thirdPlace = thirdPlaceChoice ?? schedule.third_place;
    if (teams.length !== schedule.team_ids.length || teams.some((team) => !schedule.team_ids.includes(team.id))) throw new BadRequestException('Division teams changed since the schedule was generated');
    const preliminary = games.filter((game) => game.stage === 'preliminary');
    const expected = roundRobin(schedule.team_ids, schedule.format as 'single' | 'double');
    const generated = preliminary.filter((game) => game.schedule_id === schedule.id);
    this.sameMatches(expected, generated.map((game) => ({ homeTeamId: game.home_season_team_id!, awayTeamId: game.away_season_team_id!,
      round: game.round ?? 0, stage: 'preliminary', scheduledAt: '', venueId: '', durationMinutes: 1 })));
    const semifinals = games.filter((game) => game.stage === 'semifinal');
    if (games.some((game) => game.stage === 'final' || game.stage === 'third_place')) throw new BadRequestException('Playoff games are already scheduled.');
    let matches: ScheduleMatch[];
    let labels: Named[] = teams;
    if (!semifinals.length) {
      // The whole bracket at once. Until every round-robin game is final, the semifinals take seeds that the standings fill in later.
      const complete = preliminary.every((game) => game.status === 'completed');
      const seeds = complete ? calculateStandings(teams, preliminary.map((game) => ({ homeId: game.home_season_team_id!, awayId: game.away_season_team_id!,
        homeScore: game.home_score!, awayScore: game.away_score! }))).slice(0, 4) : this.seeds(context.divisionId);
      const bracket = this.bracket(context.divisionId, seeds, thirdPlace);
      matches = bracket.matches;
      labels = [...teams, ...bracket.labels];
    } else {
      // Semifinals saved on their own: the later games take each result now if it is in, or when it is recorded.
      if (semifinals.length !== 2) throw new BadRequestException('Playoffs need exactly two semifinals');
      semifinals.sort((a, b) => a.id.localeCompare(b.id));
      const side = (game: typeof semifinals[number], outcome: 'winner' | 'loser') => {
        if (game.status !== 'completed') return game.id + ':' + outcome;
        const homeWon = game.home_score! > game.away_score!;
        return (homeWon === (outcome === 'winner') ? game.home_season_team_id : game.away_season_team_id)!;
      };
      matches = [{ homeTeamId: side(semifinals[0], 'winner'), awayTeamId: side(semifinals[1], 'winner'), round: 2, stage: 'final' }];
      if (thirdPlace) matches.push({ homeTeamId: side(semifinals[0], 'loser'), awayTeamId: side(semifinals[1], 'loser'), round: 2, stage: 'third_place' });
      const name = (id: string | null) => teams.find((team) => team.id === id)?.name ?? '';
      labels = [...teams, ...semifinals.filter((game) => game.status !== 'completed').flatMap((game) => (['winner', 'loser'] as const).map((outcome) => ({
        id: game.id + ':' + outcome, name: pendingLabel(outcome, name(game.home_season_team_id), name(game.away_season_team_id)) })))];
    }
    return { teams, labels, matches, schedule, thirdPlace };
  }

  // Once a bracket is saved the season requires its championship, and the third-place game if chosen.
  private async recordPlayoffs(tx: Transaction<DB>, scheduleId: string, thirdPlace: boolean) {
    await tx.updateTable('league.division_schedules').set({ playoffs: true, third_place: thirdPlace }).where('id', '=', scheduleId).execute();
  }

  async previewPlayoffs(user: string, divisionId: string, input: PlayoffOptionsDto) {
    const context = await this.context(user, divisionId, this.db);
    const { teams, labels, matches } = await this.playoffMatches(this.db, context, input.thirdPlace);
    await this.validateVenues(this.db, context.leagueId, input.availability);
    await this.validatePlayoffDates(this.db, context, input.availability);
    this.checkTeamAvailability(input.availability, teams.map((team) => team.id));
    const existing = await this.existing(this.db, context.leagueId, input.availability);
    const games = this.trySchedule(() => scheduleMatches(matches, input.availability, existing), labels).map(({ aliases: _aliases, ...game }) => game);
    return { games: this.withNames(games, labels), warnings: this.warnings(games, context, input.availability.timeZone) };
  }

  async savePlayoffs(user: string, divisionId: string, input: PlayoffSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const context = await this.context(user, divisionId, tx, true);
      await this.leagueLock(tx, context.leagueId);
      const { teams, matches, schedule, thirdPlace } = await this.playoffMatches(tx, context, input.thirdPlace);
      await this.validateVenues(tx, context.leagueId, input.availability);
      await this.validatePlayoffDates(tx, context, input.availability);
      this.checkTeamAvailability(input.availability, teams.map((team) => team.id));
      this.sameMatches(matches, input.games);
      const existing = await this.existing(tx, context.leagueId, input.availability);
      this.trySchedule(() => validateSchedule(this.withAliases(input.games, matches), input.availability, existing));
      await this.insert(tx, context, schedule.id, input.games, matches);
      await this.recordPlayoffs(tx, schedule.id, thirdPlace);
      return { saved: input.games.length };
    });
  }

  // Games whose sides wait for a semifinal are saved after it, pointing at it until its result fills in the team.
  // Semifinals record their seeds; a seeded side has no team until the final standings fill it in.
  private async insert(tx: Transaction<DB>, context: DivisionContext, scheduleId: string, games: ScheduleGame[], matches: ScheduleMatch[]) {
    const isSlot = (id: string) => !!parseBracketSlot(id) || !!parseSavedSlot(id);
    const pending = (game: ScheduleGame) => isSlot(game.homeTeamId) || isSlot(game.awayTeamId);
    const row = (game: ScheduleGame) => ({ season_id: context.seasonId, division_id: context.divisionId, scheduled_at: new Date(game.scheduledAt),
      venue_id: game.venueId, duration_minutes: game.durationMinutes, stage: game.stage, round: game.round, schedule_id: scheduleId });
    // Semifinal 1 is seeds 1 and 4 and semifinal 2 is seeds 2 and 3; the number comes from the slots its winner and loser fill.
    const semifinalNumber = (game: ScheduleGame) => matches.find((item) => item.stage === 'semifinal' && item.homeTeamId === game.homeTeamId && item.awayTeamId === game.awayTeamId)
      ?.aliases?.map(parseBracketSlot).find((slot) => slot)?.semifinal;
    const team = (id: string) => {
      const seed = parseSeedSlot(id);
      if (seed && seed.divisionId !== context.divisionId) throw new BadRequestException('The schedule has changed; generate a new preview');
      return seed ? null : id;
    };
    const known = games.filter((game) => !pending(game));
    const saved = known.length ? await tx.insertInto('league.games').values(known.map((game) => {
      const number = game.stage === 'semifinal' ? semifinalNumber(game) : undefined;
      return { ...row(game), home_season_team_id: team(game.homeTeamId), away_season_team_id: team(game.awayTeamId),
        home_seed: number ?? null, away_seed: number ? 5 - number : null };
    })).returning(['id', 'stage', 'home_seed']).execute() : [];
    const later = games.filter(pending);
    if (!later.length) return;
    const savedSemifinals = new Set((await tx.selectFrom('league.games').select('id').where('division_id', '=', context.divisionId).where('stage', '=', 'semifinal').execute()).map((game) => game.id));
    const semifinalId = (number: 1 | 2) => {
      const game = saved.find((item) => item.stage === 'semifinal' && item.home_seed === number);
      if (!game) throw new BadRequestException('Schedule both semifinals with the rest of the bracket');
      return game.id;
    };
    const side = (id: string) => {
      const existing = parseSavedSlot(id);
      if (existing) {
        if (!savedSemifinals.has(existing.gameId)) throw new BadRequestException('The schedule has changed; generate a new preview');
        return { team: null, source: existing.gameId, outcome: existing.outcome };
      }
      const slot = parseBracketSlot(id);
      if (!slot) return { team: id, source: null, outcome: null };
      if (slot.divisionId !== context.divisionId) throw new BadRequestException('The schedule has changed; generate a new preview');
      return { team: null, source: semifinalId(slot.semifinal), outcome: slot.outcome };
    };
    await tx.insertInto('league.games').values(later.map((game) => {
      const home = side(game.homeTeamId);
      const away = side(game.awayTeamId);
      return { ...row(game), home_season_team_id: home.team, away_season_team_id: away.team, home_source_game_id: home.source,
        home_source_outcome: home.outcome, away_source_game_id: away.source, away_source_outcome: away.outcome };
    })).execute();
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
