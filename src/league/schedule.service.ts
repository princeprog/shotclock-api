import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { PlayoffSaveDto, ScheduleAvailabilityRequestDto, SchedulePreviewDto, ScheduleSaveDto } from './league.dto';
import { roundRobin, scheduleMatches, SchedulePlacementError, validateSchedule, type ExistingGame, type ScheduleAvailability, type ScheduleGame, type ScheduleMatch } from './schedule-algorithm';
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
      .select(['g.home_season_team_id', 'g.away_season_team_id', 'g.scheduled_at', 'g.venue_id', 'g.duration_minutes'])
      .where('s.league_id', '=', leagueId).where('g.scheduled_at', 'is not', null).execute();
    return games.map((game) => ({ homeTeamId: game.home_season_team_id, awayTeamId: game.away_season_team_id,
      scheduledAt: new Date(game.scheduled_at!).toISOString(), venueId: game.venue_id, durationMinutes: game.duration_minutes }));
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

  private trySchedule<T>(fn: () => T, teams: { id: string; name: string }[] = []): T {
    try { return fn(); } catch (error) {
      if (error instanceof SchedulePlacementError) {
        const home = teams.find((team) => team.id === error.match.homeTeamId)?.name;
        const away = teams.find((team) => team.id === error.match.awayTeamId)?.name;
        throw new BadRequestException(error.withTeamNames(home, away));
      }
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
    const existing = await this.existing(this.db, context.leagueId);
    const games = this.trySchedule(() => scheduleMatches(matches, input.availability, existing), teams);
    return { games: this.withNames(games, teams), warnings: this.warnings(games, context, input.availability.timeZone) };
  }

  async savePlayoffs(user: string, divisionId: string, input: PlayoffSaveDto) {
    return this.db.transaction().execute(async (tx) => {
      const context = await this.context(user, divisionId, tx, true);
      await this.leagueLock(tx, context.leagueId);
      const { matches, schedule } = await this.playoffMatches(tx, context);
      await this.validateVenues(tx, context.leagueId, input.availability);
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
