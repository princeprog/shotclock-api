import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { ensureNotArchived } from '../common/request-scope';
import { LeagueService } from './league.service';
import { liveSnapshot } from './live-snapshot';
import type { LiveClockDto, LiveEventDto, LiveStartDto } from './league.dto';

type Database = Kysely<DB> | Transaction<DB>;
export const SCORER_MOVED = 'This game is being scored on another device.';
const PLAYER_KINDS = ['points', 'rebound', 'assist', 'steal', 'block', 'turnover', 'foul'] as const;

// Live scoring: one device holds a live game and records plays as events. Score, fouls and player lines are always
// derived from the events that were not undone, and finishing writes the result and player stats like a manual score.
@Injectable()
export class LiveService {
  constructor(private readonly database: DatabaseService, private readonly league: LeagueService) {}
  private get db() { return this.database.db; }

  // The organization owner or a scorekeeper of the game's league may score it.
  private async access(user: string, gameId: string, db: Database, lock = false) {
    let query = db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .leftJoin('league.league_members as m', (join) => join.onRef('m.league_id', '=', 'l.id').on('m.user_id', '=', user))
      .selectAll('g').select(['s.status as season_status', 's.archived_at as season_archived_at', 'l.archived_at as league_archived_at', 'o.archived_at as organization_archived_at',
        'o.owner_user_id', 'm.id as member_id', 'l.period_count', 'l.period_minutes', 'l.overtime_minutes', 'l.bonus_fouls'])
      .where('g.id', '=', gameId);
    if (lock) query = query.forUpdate('g');
    const game = await query.executeTakeFirst();
    if (!game || (game.owner_user_id !== user && !game.member_id)) throw new NotFoundException();
    ensureNotArchived(game.season_archived_at, game.league_archived_at, game.organization_archived_at);
    return game;
  }
  private async writable(user: string, gameId: string, tx: Transaction<DB>) {
    const game = await this.access(user, gameId, tx, true);
    if (game.season_status !== 'active') throw new BadRequestException('Start the season before scoring games');
    return game;
  }
  private async liveState(tx: Transaction<DB>, gameId: string, deviceId: string) {
    const state = await tx.selectFrom('league.game_live_states').selectAll().where('game_id', '=', gameId).executeTakeFirst();
    if (!state || state.finished_at) throw new BadRequestException('This game is not live');
    if (state.scorer_device_id !== deviceId) throw new ConflictException(SCORER_MOVED);
    return state;
  }
  // Every change bumps the version and tells listening API instances, after commit, that the game changed.
  private async bump(tx: Transaction<DB>, gameId: string, values: Partial<{ period: number; clock_remaining_ms: number; clock_running_since: Date | null; scorer_device_id: string | null; scorer_user_id: string | null; finished_at: Date | null }> = {}) {
    await tx.updateTable('league.game_live_states').set({ ...values, version: sql`version + 1`, updated_at: new Date() }).where('game_id', '=', gameId).execute();
    await sql`select pg_notify('game_live', ${gameId})`.execute(tx);
  }
  private periodLength(state: { period_count: number; period_minutes: number; overtime_minutes: number }, period: number) {
    return (period > state.period_count ? state.overtime_minutes : state.period_minutes) * 60_000;
  }

  snapshot(gameId: string, db: Database = this.db, includeScorer = true) { return liveSnapshot(db, gameId, includeScorer); }

  async get(user: string, gameId: string) {
    await this.access(user, gameId, this.db);
    return this.snapshot(gameId);
  }

  async start(user: string, gameId: string, dto: LiveStartDto) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    const existing = await tx.selectFrom('league.game_live_states').select(['scorer_device_id', 'finished_at']).where('game_id', '=', gameId).executeTakeFirst();
    if (game.status === 'live' && existing?.scorer_device_id === dto.deviceId) return;
    if (game.status !== 'scheduled') throw new ConflictException(game.status === 'live' ? SCORER_MOVED : 'This game already has a final score');
    if (!game.home_season_team_id || !game.away_season_team_id) throw new BadRequestException('Both teams must be known before the game starts');
    await tx.insertInto('league.game_live_states').values({ game_id: gameId, period: 1, period_count: dto.periodCount, period_minutes: dto.periodMinutes, overtime_minutes: dto.overtimeMinutes,
      bonus_fouls: dto.bonusFouls, clock_remaining_ms: dto.periodMinutes * 60_000, scorer_user_id: user, scorer_device_id: dto.deviceId, started_by_user_id: user }).execute();
    await tx.updateTable('league.games').set({ status: 'live', updated_at: new Date() }).where('id', '=', gameId).execute();
    await sql`select pg_notify('game_live', ${gameId})`.execute(tx);
  }); return this.snapshot(gameId); }

  // Another device takes over a live game; the previous device can no longer record plays.
  async claim(user: string, gameId: string, deviceId: string) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await tx.selectFrom('league.game_live_states').select('finished_at').where('game_id', '=', gameId).executeTakeFirst();
    if (!state || state.finished_at) throw new BadRequestException('This game is not live');
    await this.bump(tx, gameId, { scorer_device_id: deviceId, scorer_user_id: user });
  }); return this.snapshot(gameId); }

  // Plays carry IDs made on the device, so a batch sent again after a lost response is not counted twice.
  async record(user: string, gameId: string, deviceId: string, events: LiveEventDto[]) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    await this.liveState(tx, gameId, deviceId);
    const sides = [game.home_season_team_id, game.away_season_team_id];
    const rosters = await tx.selectFrom('league.rosters').select(['id', 'season_team_id']).where('season_team_id', 'in', sides.filter((id): id is string => !!id)).execute();
    const rosterTeam = new Map(rosters.map((roster) => [roster.id, roster.season_team_id]));
    const known = new Set((await tx.selectFrom('league.game_events').select('id').where('id', 'in', events.map((event) => event.id)).execute()).map((row) => row.id));
    let sequence = (await tx.selectFrom('league.game_events').select(sql<number>`coalesce(max(sequence), 0)`.as('last')).where('game_id', '=', gameId).executeTakeFirstOrThrow()).last;
    for (const event of events) {
      if (known.has(event.id)) continue;
      if (!sides.includes(event.seasonTeamId)) throw new BadRequestException('A play must belong to one of the two teams');
      const playerKind = (PLAYER_KINDS as readonly string[]).includes(event.kind);
      if (playerKind && rosterTeam.get(event.rosterId ?? '') !== event.seasonTeamId) throw new BadRequestException('Choose a player from that team’s roster');
      if (!playerKind && event.rosterId) throw new BadRequestException('A timeout belongs to the team, not a player');
      if ((event.kind === 'points') !== (event.points !== undefined && event.points !== null)) throw new BadRequestException('Points must be 1, 2 or 3 for a scoring play');
      sequence += 1;
      await tx.insertInto('league.game_events').values({ id: event.id, game_id: gameId, sequence, kind: event.kind, points: event.kind === 'points' ? event.points! : null, season_team_id: event.seasonTeamId,
        roster_id: playerKind ? event.rosterId! : null, period: event.period, clock_ms: event.clockMs ?? null, recorded_by_user_id: user, device_id: deviceId, client_recorded_at: new Date(event.recordedAt) }).execute();
    }
    await this.bump(tx, gameId);
  }); return this.snapshot(gameId); }

  async undo(user: string, gameId: string, deviceId: string, eventId: string) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    await this.liveState(tx, gameId, deviceId);
    const event = await tx.selectFrom('league.game_events').select(['id', 'kind', 'voided_at']).where('id', '=', eventId).where('game_id', '=', gameId).executeTakeFirst();
    if (!event) throw new NotFoundException();
    if (event.kind === 'period_end') throw new BadRequestException('A period change cannot be undone');
    if (!event.voided_at) await tx.updateTable('league.game_events').set({ voided_at: new Date(), voided_by_user_id: user }).where('id', '=', eventId).execute();
    await this.bump(tx, gameId);
  }); return this.snapshot(gameId); }

  // The scoring device runs the clock, so its reading at the given moment is stored as the official time.
  async clock(user: string, gameId: string, dto: LiveClockDto) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, dto.deviceId);
    const at = Math.min(new Date(dto.at).getTime(), Date.now());
    const remainingMs = Math.min(dto.remainingMs, this.periodLength(state, state.period));
    await this.bump(tx, gameId, { clock_remaining_ms: remainingMs, clock_running_since: dto.running && remainingMs > 0 ? new Date(at) : null });
  }); return this.snapshot(gameId); }

  // Regulation periods follow each other; after the last one, another period is overtime and only allowed when tied.
  async nextPeriod(user: string, gameId: string, deviceId: string) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, deviceId);
    if (state.clock_running_since) throw new BadRequestException('Stop the clock before ending the period');
    if (state.period >= 20) throw new BadRequestException('A game cannot have more periods');
    if (state.period >= state.period_count) {
      const current = await this.snapshot(gameId, tx);
      if (current.home.score !== current.away.score) throw new BadRequestException('Overtime is only played when the score is tied');
    }
    const last = (await tx.selectFrom('league.game_events').select(sql<number>`coalesce(max(sequence), 0)`.as('last')).where('game_id', '=', gameId).executeTakeFirstOrThrow()).last;
    await tx.insertInto('league.game_events').values({ id: sql<string>`gen_random_uuid()`, game_id: gameId, sequence: last + 1, kind: 'period_end', period: state.period, clock_ms: state.clock_remaining_ms, recorded_by_user_id: user, device_id: deviceId }).execute();
    await this.bump(tx, gameId, { period: state.period + 1, clock_remaining_ms: this.periodLength(state, state.period + 1), clock_running_since: null });
  }); return this.snapshot(gameId); }

  // Finishing writes the final score through the normal result path, so standings and brackets update as usual,
  // and replaces the game's player stats with the totals of its plays.
  async finish(user: string, gameId: string, deviceId: string) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, deviceId);
    if (state.period < state.period_count) throw new BadRequestException('Play every regulation period before finishing the game');
    if (state.clock_running_since) throw new BadRequestException('Stop the clock before finishing the game');
    const current = await this.snapshot(gameId, tx);
    if (current.home.score === current.away.score) throw new BadRequestException('The score is tied. Start overtime to decide the game.');
    await tx.deleteFrom('league.player_game_stats').where('game_id', '=', gameId).execute();
    const lines = [...current.home.players, ...current.away.players].filter((line) => line.points + line.rebounds + line.assists + line.steals + line.blocks + line.turnovers + line.fouls > 0);
    if (lines.length) await tx.insertInto('league.player_game_stats').values(lines.map((line) => ({ game_id: gameId, roster_id: line.rosterId, points: line.points, rebounds: line.rebounds,
      assists: line.assists, steals: line.steals, blocks: line.blocks, turnovers: line.turnovers, fouls: line.fouls }))).execute();
    const { period_count: _a, period_minutes: _b, overtime_minutes: _c, bonus_fouls: _d, season_status: _e, season_archived_at: _f, league_archived_at: _g, organization_archived_at: _h, owner_user_id: _i, member_id: _j, ...row } = game;
    await this.league.recordGameResult(tx, game.season_id, row, { homeScore: current.home.score, awayScore: current.away.score });
    await this.bump(tx, gameId, { finished_at: new Date(), clock_running_since: null });
  }); return this.snapshot(gameId); }

  // Only the owner reopens a finished live game, and only while nothing after it depends on its result.
  async reopen(user: string, gameId: string) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    if (game.owner_user_id !== user) throw new NotFoundException();
    const state = await tx.selectFrom('league.game_live_states').select('finished_at').where('game_id', '=', gameId).executeTakeFirst();
    if (game.status !== 'completed' || !state?.finished_at) throw new BadRequestException('Only finished live games can be reopened');
    if (game.stage === 'preliminary') {
      const filled = await tx.selectFrom('league.games').select('id').where('season_id', '=', game.season_id).where('division_id', '=', game.division_id).where('stage', '=', 'semifinal').where('home_season_team_id', 'is not', null).executeTakeFirst();
      if (filled) throw new BadRequestException('The semifinals are already set from these standings, so this game cannot be reopened');
    }
    if (game.stage === 'semifinal') {
      const next = await tx.selectFrom('league.games').select('status').where((eb) => eb.or([eb('home_source_game_id', '=', gameId), eb('away_source_game_id', '=', gameId)])).execute();
      if (next.some((item) => item.status !== 'scheduled')) throw new BadRequestException('The next playoff game has started, so this semifinal cannot be reopened');
    }
    await tx.updateTable('league.games').set({ status: 'live', home_score: null, away_score: null, forfeited_by_season_team_id: null, updated_at: new Date() }).where('id', '=', gameId).execute();
    await tx.deleteFrom('league.player_game_stats').where('game_id', '=', gameId).execute();
    await this.bump(tx, gameId, { finished_at: null, clock_running_since: null, scorer_device_id: null, scorer_user_id: null });
  }); return this.snapshot(gameId); }
}

