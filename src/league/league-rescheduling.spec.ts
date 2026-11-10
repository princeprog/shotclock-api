import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import { Kysely, PostgresDialect } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { GameDto } from './league.dto';
import { LeagueService } from './league.service';

const time = '2026-11-10T10:00:00Z';
const dto = { homeTeamId: 'a', awayTeamId: 'b', scheduledAt: time, venueId: 'court' };
type TestGame = { id: string; season_id: string; division_id: string; status: string; schedule_id: string | null; home_season_team_id: string; away_season_team_id: string; scheduled_at: Date; venue_id: string | null; duration_minutes: number | null };
const game = (overrides: Partial<TestGame> = {}): TestGame => ({ id: 'game', season_id: 'season', division_id: 'division', status: 'scheduled', schedule_id: null, home_season_team_id: 'a', away_season_team_id: 'b', scheduled_at: new Date(time), venue_id: 'court', duration_minutes: 60, ...overrides });

function setup() {
  const state = { current: game(), others: [] as ReturnType<typeof game>[], owner: true, queries: [] as { text: string; values: readonly unknown[] }[], history: [] as Record<string, unknown>[], failHistory: false };
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      state.queries.push({ text, values });
      let rows: object[] = [];
      if (text.includes('from "league"."seasons"')) rows = state.owner ? [{ id: 'season', league_id: 'league', status: 'active' }] : [];
      else if (text.includes('from "league"."season_teams"')) rows = values.filter((v) => ['a', 'b', 'c', 'd'].includes(String(v))).map((id) => ({ id, division_id: 'division' }));
      else if (text.includes('from "league"."venues"')) rows = [{ id: 'court' }];
      else if (text.includes('from "league"."game_schedule_changes"')) rows = state.history;
      else if (text.includes('from "league"."games" as "g"')) rows = state.others;
      else if (text.includes('from "league"."games"')) rows = [state.current];
      else if (text.startsWith('update "league"."games"')) {
        const changes: Record<string, unknown> = {};
        for (const [, field, index] of text.matchAll(/"([a-z_]+)" = \$(\d+)/g)) changes[field] = values[Number(index) - 1];
        rows = [{ ...state.current, ...changes }];
      } else if (text.startsWith('insert into "league"."game_schedule_changes"')) {
        if (state.failHistory) throw new Error('history insert failed');
        const columns = text.match(/\(([^)]+)\) values/)?.[1].match(/"[^"]+"/g) ?? [];
        state.history.push(Object.fromEntries(columns.map((column, index) => [column.slice(1, -1), values[index]])));
      }
      return { command: text.split(' ')[0].toUpperCase(), rowCount: rows.length, rows };
    },
    release() {},
  };
  const pool = { connect: async () => client, end: async () => {} } as unknown as Pool;
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { state, db, service: new LeagueService({ db } as DatabaseService) };
}

describe('game rescheduling', () => {
  it('validates optional duration as an integer between 1 and 1440', async () => {
    for (const durationMinutes of [null, 0, 1441, 1.5]) {
      const input = Object.assign(new GameDto(), { homeTeamId: 'b1b781b7-8862-4687-a9de-d68dd964a3cd', awayTeamId: 'c1b781b7-8862-4687-a9de-d68dd964a3cd', scheduledAt: time, durationMinutes });
      expect((await validate(input)).some((error) => error.property === 'durationMinutes')).toBe(true);
    }
  });

  it('preserves a legacy null duration and creates no history for a no-op', async () => {
    const { state, service, db } = setup(); state.current.duration_minutes = null;
    await service.editGame('owner', 'game', dto);
    expect(state.history).toHaveLength(0);
    expect(state.queries.some((q) => q.text.includes('from "league"."games" as "g"'))).toBe(false);
    await db.destroy();
  });

  it('persists and records an explicit 60-minute duration on a legacy game', async () => {
    const { state, service, db } = setup(); state.current.duration_minutes = null;
    const result = await service.editGame('owner', 'game', { ...dto, durationMinutes: 60 });
    expect(result.duration_minutes).toBe(60);
    expect(state.history).toEqual([expect.objectContaining({ old_duration_minutes: null, new_duration_minutes: 60 })]);
    await db.destroy();
  });

  it('checks participant-only changes against registrations and creates no history', async () => {
    const { state, service, db } = setup();
    state.others.push(game({ id: 'other', venue_id: 'elsewhere', home_season_team_id: 'c', away_season_team_id: 'd' }));
    await expect(service.editGame('owner', 'game', { ...dto, homeTeamId: 'c' })).rejects.toThrow(BadRequestException);
    expect(state.history).toHaveLength(0);
    await db.destroy();
  });

  it('leaves legacy duration untouched for a conflict-free participant-only edit', async () => {
    const { state, service, db } = setup(); state.current.duration_minutes = null;
    const result = await service.editGame('owner', 'game', { ...dto, homeTeamId: 'c' });
    expect(result.duration_minutes).toBeNull();
    expect(state.history).toHaveLength(0);
    await db.destroy();
  });

  it('uses the existing game duration rather than the candidate duration', async () => {
    const { state, service, db } = setup();
    state.others.push(game({ id: 'other', home_season_team_id: 'c', away_season_team_id: 'd', scheduled_at: new Date('2026-11-10T09:00:00Z'), duration_minutes: 90 }));
    await expect(service.editGame('owner', 'game', { ...dto, durationMinutes: 30 })).rejects.toThrow(BadRequestException);
    await db.destroy();
  });

  it.each([
    ['same venue across seasons', { venue_id: 'court', season_id: 'other-season', home_season_team_id: 'c', away_season_team_id: 'd' }],
    ['same registration elsewhere', { venue_id: 'elsewhere', home_season_team_id: 'c', away_season_team_id: 'a' }],
    ['legacy conflicting duration', { venue_id: 'court', home_season_team_id: 'c', away_season_team_id: 'd', scheduled_at: new Date('2026-11-10T09:15:00Z'), duration_minutes: null }],
  ])('rejects %s', async (_label, other) => {
    const { state, service, db } = setup(); state.others.push(game({ id: 'other', ...other }));
    await expect(service.editGame('owner', 'game', { ...dto, scheduledAt: '2026-11-10T10:01:00Z' })).rejects.toThrow(BadRequestException);
    expect(state.history).toHaveLength(0);
    await db.destroy();
  });

  it('allows adjacent games and distinct registrations, recording the legacy fallback atomically', async () => {
    const { state, service, db } = setup(); state.current.duration_minutes = null;
    state.others.push(game({ id: 'other', venue_id: 'elsewhere', home_season_team_id: 'other-division-a', away_season_team_id: 'd' }));
    state.others.push(game({ id: 'adjacent', home_season_team_id: 'c', away_season_team_id: 'd', scheduled_at: new Date('2026-11-10T11:01:00Z') }));
    const result = await service.editGame('owner', 'game', { ...dto, scheduledAt: '2026-11-10T10:01:00Z' });
    expect(result.duration_minutes).toBe(60);
    expect(state.history).toEqual([expect.objectContaining({ game_id: 'game', changed_by_user_id: 'owner', old_duration_minutes: null, new_duration_minutes: 60 })]);
    const lock = state.queries.findIndex((q) => q.text.includes('pg_advisory_xact_lock'));
    expect(lock).toBeGreaterThan(state.queries.findIndex((q) => q.text.includes('for update')));
    expect(state.queries.findIndex((q) => q.text.includes('from "league"."games" as "g"'))).toBeGreaterThan(lock);
    expect(state.queries.at(-1)?.text).toBe('commit');
    await db.destroy();
  });

  it('rolls back when history cannot be recorded', async () => {
    const { state, service, db } = setup(); state.failHistory = true;
    await expect(service.editGame('owner', 'game', { ...dto, durationMinutes: 90 })).rejects.toThrow('history insert failed');
    expect(state.queries.at(-1)?.text).toBe('rollback');
    await db.destroy();
  });

  it('protects completed and generated games', async () => {
    const { state, service, db } = setup(); state.current.status = 'completed';
    await expect(service.editGame('owner', 'game', dto)).rejects.toThrow(BadRequestException);
    state.current.status = 'scheduled'; state.current.schedule_id = 'schedule';
    await expect(service.editGame('owner', 'game', { ...dto, homeTeamId: 'c' })).rejects.toThrow(BadRequestException);
    await db.destroy();
  });

  it('checks ownership before returning joined, newest-first history', async () => {
    const { state, service, db } = setup(); state.owner = false;
    await expect(service.scheduleHistory('other', 'game')).rejects.toThrow(NotFoundException);
    expect(state.queries.some((q) => q.text.includes('game_schedule_changes'))).toBe(false);
    state.owner = true;
    await service.scheduleHistory('owner', 'game');
    const query = state.queries.find((q) => q.text.includes('game_schedule_changes'))!.text;
    expect(query).toContain('left join "league"."venues" as "old_venue"');
    expect(query).toContain('left join "league"."venues" as "new_venue"');
    expect(query).toContain('"changed_at" desc');
    await db.destroy();
  });
});

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('game rescheduling against disposable PostgreSQL', () => {
  let app: INestApplication;
  const emails: { email: string; token: string }[] = [];
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('serializes competing edits and exposes owner-only history with venue names', async () => {
    await app.get(DatabaseService).db.deleteFrom('auth.rate_limits').execute();
    async function login() {
      const email = `${randomUUID()}@example.test`; const password = 'correct-horse-battery-123';
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
      await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email)!.token }).expect(200);
      return `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}`;
    }
    const owner = await login(); const other = await login();
    const post = (url: string, body: object) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', owner).send(body);
    const get = (url: string, auth = owner) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth);
    const patch = (url: string, body: object) => request(app.getHttpServer()).patch(`/league${url}`).set('Authorization', owner).send(body);
    const org = (await post('/organizations', { name: 'Rescheduling' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'League' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Season' }).expect(201)).body;
    const division = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    const venue = (await post(`/leagues/${league.id}/venues`, { name: 'Court' }).expect(201)).body;
    for (const name of ['A', 'B', 'C', 'D']) await post(`/leagues/${league.id}/teams`, { name, seasonId: season.id, divisionId: division.id }).expect(201);
    const teams = (await get(`/seasons/${season.id}/teams?divisionId=${division.id}`).expect(200)).body;
    const inputs = [0, 1].map((index) => ({ homeTeamId: teams[index * 2].id, awayTeamId: teams[index * 2 + 1].id, venueId: venue.id, scheduledAt: `2026-11-10T0${8 + index}:00:00Z` }));
    const games = await Promise.all(inputs.map(async (input) => (await post(`/seasons/${season.id}/games`, input).expect(201)).body));
    const withDuration = (await post(`/seasons/${season.id}/games`, { ...inputs[0], scheduledAt: '2026-11-11T08:00:00Z', durationMinutes: 75 }).expect(201)).body;
    expect(withDuration.duration_minutes).toBe(75);
    const edits = await Promise.all(games.map((item, index) => patch(`/games/${item.id}`, { ...inputs[index], scheduledAt: time, durationMinutes: 90 })));
    expect(edits.map((response) => response.status).sort()).toEqual([200, 400]);
    const winner = edits.findIndex((response) => response.status === 200);
    await get(`/games/${games[winner].id}/schedule-history`, other).expect(404);
    const history = (await get(`/games/${games[winner].id}/schedule-history`).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ old_venue_name: 'Court', new_venue_name: 'Court', old_duration_minutes: null, new_duration_minutes: 90 });
    await patch(`/games/${games[winner].id}`, { ...inputs[winner], scheduledAt: time, durationMinutes: 90 }).expect(200);
    expect((await get(`/games/${games[winner].id}/schedule-history`).expect(200)).body).toHaveLength(1);
    expect((await get(`/games/${games[1 - winner].id}/schedule-history`).expect(200)).body).toHaveLength(0);
    await patch(`/games/${games[winner].id}`, { ...inputs[winner], scheduledAt: '2026-11-10T12:00:00Z', venueId: null }).expect(200);
    const latest = (await get(`/games/${games[winner].id}/schedule-history`).expect(200)).body;
    expect(latest).toHaveLength(2);
    expect(latest[0]).toMatchObject({ old_venue_name: 'Court', new_venue_name: null, old_duration_minutes: 90, new_duration_minutes: 90 });
    expect(latest[1].id).toBe(history[0].id);
    const stored = await app.get(DatabaseService).db.selectFrom('league.game_schedule_changes').select('changed_by_user_id').where('id', '=', latest[0].id).executeTakeFirstOrThrow();
    expect(stored.changed_by_user_id).toBe(org.owner_user_id);
  });
});
