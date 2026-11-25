import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { ensureNotArchived } from '../common/request-scope';
import { LeagueService } from './league.service';
import { liveSnapshot } from './live-snapshot';
import { bestPlayer } from './best-player';
import type { LiveClockDto, LiveEventDto, LiveStartDto, ShotClockCommandDto, ShotClockHeartbeatDto, ShotClockModeDto } from './league.dto';

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
  private async shotState(tx: Transaction<DB>, gameId: string) {
    return tx.selectFrom('league.game_shot_clocks').selectAll().where('game_id', '=', gameId).executeTakeFirst();
  }
  private checkEpoch(shot: { epoch: number }, epoch?: number) {
    if (epoch !== shot.epoch) throw new ConflictException('Shot-clock control changed. Refresh and discard stale queued changes.');
  }
  private checkLeases(shot: { mode: string; scorer_lease_until: Date | null; operator_lease_until: Date | null }) {
    if (shot.mode === 'dual' && (!shot.scorer_lease_until || !shot.operator_lease_until ||
      new Date(shot.scorer_lease_until).getTime() <= Date.now() || new Date(shot.operator_lease_until).getTime() <= Date.now()))
      throw new ConflictException('Both devices must be connected to control this game.');
  }
  private async scoringFence(tx: Transaction<DB>, gameId: string, epoch?: number) {
    const shot = await this.shotState(tx, gameId);
    if (shot) this.checkEpoch({ epoch: shot.scorer_epoch }, epoch);
    return shot;
  }
  private eventTime(value: string) {
    const at = new Date(value).getTime();
    if (!Number.isFinite(at)) throw new BadRequestException('Invalid event time');
    return Math.min(at, Date.now());
  }
  private lease() { return new Date(Date.now() + 15_000); }
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
    if (dto.shotClockEnabled) await tx.insertInto('league.game_shot_clocks').values({ game_id: gameId, full_seconds: dto.shotClockFullSeconds ?? 24,
      short_seconds: dto.shotClockShortSeconds ?? 14, remaining_ms: (dto.shotClockFullSeconds ?? 24) * 1000, scorer_lease_until: this.lease() }).execute();
    await tx.updateTable('league.games').set({ status: 'live', updated_at: new Date() }).where('id', '=', gameId).execute();
    await sql`select pg_notify('game_live', ${gameId})`.execute(tx);
  }); return this.snapshot(gameId); }

  // Another device takes over a live game; the previous device can no longer record plays.
  async claim(user: string, gameId: string, deviceId: string) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await tx.selectFrom('league.game_live_states').select(['finished_at', 'scorer_device_id', 'scorer_user_id']).where('game_id', '=', gameId).executeTakeFirst();
    if (!state || state.finished_at) throw new BadRequestException('This game is not live');
    const shot = await this.shotState(tx, gameId);
    if (shot && (state.scorer_device_id !== deviceId || state.scorer_user_id !== user)) {
      await tx.updateTable('league.game_shot_clocks').set({ epoch: shot.epoch + 1, scorer_epoch: shot.scorer_epoch + 1, scorer_lease_until: this.lease(),
        ...(shot.operator_device_id === deviceId ? { operator_device_id: null, operator_user_id: null, operator_lease_until: null } : {}) }).where('game_id', '=', gameId).execute();
    }
    await this.bump(tx, gameId, { scorer_device_id: deviceId, scorer_user_id: user });
  }); return this.snapshot(gameId); }

  // Plays carry IDs made on the device, so a batch sent again after a lost response is not counted twice.
  async record(user: string, gameId: string, deviceId: string, events: LiveEventDto[], epoch?: number) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    await this.liveState(tx, gameId, deviceId);
    await this.scoringFence(tx, gameId, epoch);
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

  async undo(user: string, gameId: string, deviceId: string, eventId: string, epoch?: number) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    await this.liveState(tx, gameId, deviceId);
    await this.scoringFence(tx, gameId, epoch);
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
    const shot = await this.scoringFence(tx, gameId, dto.epoch);
    const at = shot ? this.eventTime(dto.at) : Math.min(new Date(dto.at).getTime(), Date.now());
    if (shot) {
      if (shot.last_game_clock_at && at <= new Date(shot.last_game_clock_at).getTime()) {
        const sameTime = at === new Date(shot.last_game_clock_at).getTime();
        const expectedRunning = dto.running && dto.remainingMs > 0;
        if (sameTime && state.clock_remaining_ms === Math.min(dto.remainingMs, this.periodLength(state, state.period)) &&
          !!state.clock_running_since === expectedRunning && (!expectedRunning || new Date(state.clock_running_since!).getTime() === at)) return;
        throw new ConflictException('This clock change is older than the current state.');
      }
      const stop = !dto.running || dto.remainingMs === 0;
      if (stop) {
        const retroactive = !!shot.last_shot_at && at < new Date(shot.last_shot_at).getTime();
        const historical = retroactive ? await tx.selectFrom('league.game_shot_clock_history').selectAll().where('game_id', '=', gameId)
          .where('period', '=', state.period).where('at', '<=', new Date(at)).orderBy('at', 'desc').orderBy('id', 'desc').executeTakeFirst() : undefined;
        const base = retroactive ? historical ?? { remaining_ms: shot.full_seconds * 1000, running_since: null, visible: true } : shot;
        const end = state.clock_running_since ? Math.min(at, new Date(state.clock_running_since).getTime() + state.clock_remaining_ms) : at;
        const elapsed = base.running_since ? Math.max(0, end - new Date(base.running_since).getTime()) : 0;
        const remaining = Math.max(0, base.remaining_ms - elapsed);
        if (retroactive) await tx.deleteFrom('league.game_shot_clock_history').where('game_id', '=', gameId).where('period', '=', state.period).where('at', '>', new Date(at)).execute();
        await tx.insertInto('league.game_shot_clock_history').values({ game_id: gameId, period: state.period, at: new Date(at), remaining_ms: remaining, running_since: null, visible: base.visible }).execute();
        await tx.updateTable('league.game_shot_clocks').set({ last_game_clock_at: new Date(at), remaining_ms: remaining, running_since: null,
          visible: base.visible, last_shot_at: new Date(at), ...(retroactive ? { epoch: shot.epoch + 1 } : {}) }).where('game_id', '=', gameId).execute();
      } else await tx.updateTable('league.game_shot_clocks').set({ last_game_clock_at: new Date(at) }).where('game_id', '=', gameId).execute();
    }
    const remainingMs = Math.min(dto.remainingMs, this.periodLength(state, state.period));
    await this.bump(tx, gameId, { clock_remaining_ms: remainingMs, clock_running_since: dto.running && remainingMs > 0 ? new Date(at) : null });
  }); return this.snapshot(gameId); }

  async shotClock(user: string, gameId: string, dto: ShotClockCommandDto) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await tx.selectFrom('league.game_live_states').selectAll().where('game_id', '=', gameId).executeTakeFirst();
    const shot = await this.shotState(tx, gameId);
    if (!state || state.finished_at || !shot) throw new BadRequestException('The shot clock is not enabled for a live game');
    this.checkEpoch(shot, dto.epoch);
    const holder = shot.mode === 'single' ? state.scorer_device_id === dto.deviceId && state.scorer_user_id === user : shot.operator_device_id === dto.deviceId && shot.operator_user_id === user;
    if (!holder) throw new ConflictException('Another device controls the shot clock.');
    this.checkLeases(shot);
    const duplicate = await tx.selectFrom('league.game_shot_clock_commands').selectAll().where('id', '=', dto.commandId).executeTakeFirst();
    if (duplicate) {
      if (duplicate.game_id !== gameId || duplicate.device_id !== dto.deviceId || duplicate.epoch !== dto.epoch) throw new ConflictException('Command ID already used.');
      return;
    }
    const at = this.eventTime(dto.at);
    if (shot.last_shot_at && at <= new Date(shot.last_shot_at).getTime()) throw new ConflictException('This shot-clock change is older than the current state.');
    if (dto.running && (!state.clock_running_since || at < new Date(state.clock_running_since).getTime() ||
      at >= new Date(state.clock_running_since).getTime() + state.clock_remaining_ms)) throw new BadRequestException('Start the game clock before the shot clock.');
    const inserted = await tx.insertInto('league.game_shot_clock_commands').values({ id: dto.commandId, game_id: gameId, device_id: dto.deviceId, epoch: dto.epoch })
      .onConflict((conflict) => conflict.column('id').doNothing()).returning('id').executeTakeFirst();
    if (!inserted) throw new ConflictException('Command ID already used.');
    await tx.insertInto('league.game_shot_clock_history').values({ game_id: gameId, period: state.period, at: new Date(at), remaining_ms: dto.remainingMs, running_since: dto.running && dto.remainingMs > 0 ? new Date(at) : null, visible: dto.visible }).execute();
    await tx.updateTable('league.game_shot_clocks').set({ remaining_ms: dto.remainingMs, running_since: dto.running && dto.remainingMs > 0 ? new Date(at) : null,
      visible: dto.visible, last_shot_at: new Date(at) }).where('game_id', '=', gameId).execute();
    await this.bump(tx, gameId);
  }); return this.snapshot(gameId); }

  async shotMode(user: string, gameId: string, dto: ShotClockModeDto) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, dto.deviceId);
    if (state.scorer_user_id !== user) throw new ConflictException(SCORER_MOVED);
    const shot = await this.shotState(tx, gameId);
    if (!shot) throw new BadRequestException('The shot clock is not enabled');
    this.checkEpoch(shot, dto.epoch);
    if (shot.mode !== dto.mode) {
      await tx.updateTable('league.game_shot_clocks').set({ mode: dto.mode, epoch: shot.epoch + 1, scorer_epoch: shot.scorer_epoch + 1, operator_device_id: null,
        operator_user_id: null, scorer_lease_until: this.lease(), operator_lease_until: null }).where('game_id', '=', gameId).execute();
      await this.bump(tx, gameId);
    }
  }); return this.snapshot(gameId); }

  async shotClaim(user: string, gameId: string, deviceId: string, epoch: number) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await tx.selectFrom('league.game_live_states').selectAll().where('game_id', '=', gameId).executeTakeFirst();
    const shot = await this.shotState(tx, gameId);
    if (!state || state.finished_at || !shot || shot.mode !== 'dual') throw new BadRequestException('The shot clock is not in dual mode');
    this.checkEpoch(shot, epoch);
    if (state.scorer_device_id === deviceId) throw new ConflictException('The scoring device cannot claim the shot-clock role in dual mode.');
    if (shot.operator_device_id !== deviceId || shot.operator_user_id !== user) {
      await tx.updateTable('league.game_shot_clocks').set({ operator_device_id: deviceId, operator_user_id: user, operator_lease_until: this.lease(), epoch: shot.epoch + 1 }).where('game_id', '=', gameId).execute();
      await this.bump(tx, gameId);
    }
  }); return this.snapshot(gameId); }

  async shotHeartbeat(user: string, gameId: string, dto: ShotClockHeartbeatDto) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await tx.selectFrom('league.game_live_states').selectAll().where('game_id', '=', gameId).executeTakeFirst();
    const shot = await this.shotState(tx, gameId);
    if (!state || state.finished_at || !shot) throw new BadRequestException('The shot clock is not enabled for a live game');
    this.checkEpoch(shot, dto.epoch);
    if (state.scorer_device_id === dto.deviceId && state.scorer_user_id === user) {
      await tx.updateTable('league.game_shot_clocks').set({ scorer_lease_until: this.lease() }).where('game_id', '=', gameId).execute();
    } else if (shot.mode === 'dual' && shot.operator_device_id === dto.deviceId && shot.operator_user_id === user) {
      await tx.updateTable('league.game_shot_clocks').set({ operator_lease_until: this.lease() }).where('game_id', '=', gameId).execute();
    } else throw new ConflictException('This device does not hold a live role.');
  }); return this.snapshot(gameId); }

  // Regulation periods follow each other; after the last one, another period is overtime and only allowed when tied.
  async nextPeriod(user: string, gameId: string, deviceId: string, epoch?: number) { await this.db.transaction().execute(async (tx) => {
    await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, deviceId);
    const shot = await this.scoringFence(tx, gameId, epoch);
    if (state.clock_running_since) throw new BadRequestException('Stop the clock before ending the period');
    if (state.period >= 20) throw new BadRequestException('A game cannot have more periods');
    if (state.period >= state.period_count) {
      const current = await this.snapshot(gameId, tx);
      if (current.home.score !== current.away.score) throw new BadRequestException('Overtime is only played when the score is tied');
    }
    const last = (await tx.selectFrom('league.game_events').select(sql<number>`coalesce(max(sequence), 0)`.as('last')).where('game_id', '=', gameId).executeTakeFirstOrThrow()).last;
    await tx.insertInto('league.game_events').values({ id: sql<string>`gen_random_uuid()`, game_id: gameId, sequence: last + 1, kind: 'period_end', period: state.period, clock_ms: state.clock_remaining_ms, recorded_by_user_id: user, device_id: deviceId }).execute();
    if (shot) await tx.updateTable('league.game_shot_clocks').set({ remaining_ms: shot.full_seconds * 1000, running_since: null, epoch: shot.epoch + 1, scorer_epoch: shot.scorer_epoch + 1, last_shot_at: new Date(), last_game_clock_at: new Date() }).where('game_id', '=', gameId).execute();
    await this.bump(tx, gameId, { period: state.period + 1, clock_remaining_ms: this.periodLength(state, state.period + 1), clock_running_since: null });
  }); return this.snapshot(gameId); }

  // Finishing writes the final score through the normal result path, so standings and brackets update as usual,
  // and replaces the game's player stats with the totals of its plays, flagging the winning team's best player.
  async finish(user: string, gameId: string, deviceId: string, epoch?: number) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    const state = await this.liveState(tx, gameId, deviceId);
    const shot = await this.scoringFence(tx, gameId, epoch);
    if (state.period < state.period_count) throw new BadRequestException('Play every regulation period before finishing the game');
    if (state.clock_running_since) throw new BadRequestException('Stop the clock before finishing the game');
    const current = await this.snapshot(gameId, tx);
    if (current.home.score === current.away.score) throw new BadRequestException('The score is tied. Start overtime to decide the game.');
    await tx.deleteFrom('league.player_game_stats').where('game_id', '=', gameId).execute();
    const lines = [...current.home.players, ...current.away.players].filter((line) => line.points + line.rebounds + line.assists + line.steals + line.blocks + line.turnovers + line.fouls > 0);
    const best = bestPlayer((current.home.score > current.away.score ? current.home : current.away).players);
    if (lines.length) await tx.insertInto('league.player_game_stats').values(lines.map((line) => ({ game_id: gameId, roster_id: line.rosterId, points: line.points, rebounds: line.rebounds,
      assists: line.assists, steals: line.steals, blocks: line.blocks, turnovers: line.turnovers, fouls: line.fouls, best_player: line.rosterId === best?.rosterId }))).execute();
    const { period_count: _a, period_minutes: _b, overtime_minutes: _c, bonus_fouls: _d, season_status: _e, season_archived_at: _f, league_archived_at: _g, organization_archived_at: _h, owner_user_id: _i, member_id: _j, ...row } = game;
    await this.league.recordGameResult(tx, game.season_id, row, { homeScore: current.home.score, awayScore: current.away.score });
    if (shot) await tx.updateTable('league.game_shot_clocks').set({ running_since: null, epoch: shot.epoch + 1, scorer_epoch: shot.scorer_epoch + 1, scorer_lease_until: null, operator_lease_until: null }).where('game_id', '=', gameId).execute();
    await this.bump(tx, gameId, { finished_at: new Date(), clock_running_since: null });
  }); return this.snapshot(gameId); }

  // Only the owner reopens a finished live game, and only while nothing after it depends on its result.
  async reopen(user: string, gameId: string) { await this.db.transaction().execute(async (tx) => {
    const game = await this.writable(user, gameId, tx);
    if (game.owner_user_id !== user) throw new NotFoundException();
    const state = await tx.selectFrom('league.game_live_states').select('finished_at').where('game_id', '=', gameId).executeTakeFirst();
    if (game.status !== 'completed' || !state?.finished_at) throw new BadRequestException('Only finished live games can be reopened');
    if (game.stage === 'preliminary') {
      const filled = await tx.selectFrom('league.games').select('id').where('season_id', '=', game.season_id).where('division_id', '=', game.division_id).where('stage', 'in', ['quarterfinal', 'semifinal']).where('home_season_team_id', 'is not', null).executeTakeFirst();
      if (filled) throw new BadRequestException('The playoff pairings are already set from these standings, so this game cannot be reopened');
    }
    if (game.stage === 'quarterfinal' || game.stage === 'semifinal') {
      const next = await tx.selectFrom('league.games').select('status').where((eb) => eb.or([eb('home_source_game_id', '=', gameId), eb('away_source_game_id', '=', gameId)])).execute();
      if (next.some((item) => item.status !== 'scheduled')) throw new BadRequestException(`The next playoff game has started, so this ${game.stage} cannot be reopened`);
    }
    await tx.updateTable('league.games').set({ status: 'live', home_score: null, away_score: null, forfeited_by_season_team_id: null, updated_at: new Date() }).where('id', '=', gameId).execute();
    await tx.deleteFrom('league.player_game_stats').where('game_id', '=', gameId).execute();
    const shot = await this.shotState(tx, gameId);
    if (shot) await tx.updateTable('league.game_shot_clocks').set({ running_since: null, epoch: shot.epoch + 1, scorer_epoch: shot.scorer_epoch + 1, operator_device_id: null, operator_user_id: null, scorer_lease_until: null, operator_lease_until: null, last_shot_at: new Date(), last_game_clock_at: new Date() }).where('game_id', '=', gameId).execute();
    await this.bump(tx, gameId, { finished_at: null, clock_running_since: null, scorer_device_id: null, scorer_user_id: null });
  }); return this.snapshot(gameId); }
}

