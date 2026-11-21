import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;
type PreviewGame = { divisionId: string; homeTeamId: string; awayTeamId: string; stage: string; round: number; scheduledAt: string; venueId: string; durationMinutes: number };

databaseTests('season-wide scheduling against disposable PostgreSQL', () => {
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

  async function login() {
    await app.get(DatabaseService).db.deleteFrom('auth.rate_limits').execute();
    const email = `${randomUUID()}@example.test`; const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((item) => item.email === email)!.token }).expect(200);
    return `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}`;
  }

  async function fixture() {
    const owner = await login();
    const post = (url: string, body: object = {}, auth = owner) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', auth).send(body);
    const get = (url: string, auth = owner) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth);
    const patch = (url: string, body: object) => request(app.getHttpServer()).patch(`/league${url}`).set('Authorization', owner).send(body);
    const org = (await post('/organizations', { name: 'Season schedule' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'League' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Season' }).expect(201)).body;
    const open = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    const small = (await post(`/seasons/${season.id}/divisions`, { name: 'Small' }).expect(201)).body;
    const empty = (await post(`/seasons/${season.id}/divisions`, { name: 'Empty' }).expect(201)).body;
    const occupied = (await post(`/seasons/${season.id}/divisions`, { name: 'Existing' }).expect(201)).body;
    const venue = (await post(`/leagues/${league.id}/venues`, { name: 'Court' }).expect(201)).body;
    for (const [division, count] of [[open, 4], [small, 3], [occupied, 2]] as const) {
      for (let i = 0; i < count; i++) await post(`/leagues/${league.id}/teams`, { name: `${division.name} ${i}`, seasonId: season.id, divisionId: division.id }).expect(201);
    }
    const oldTeams = (await get(`/seasons/${season.id}/teams?divisionId=${occupied.id}`).expect(200)).body;
    await post(`/seasons/${season.id}/games`, { homeTeamId: oldTeams[0].id, awayTeamId: oldTeams[1].id, venueId: venue.id, scheduledAt: '2026-11-10T08:00:00Z', durationMinutes: 60 }).expect(201);
    const availability = { startDate: '2026-11-10', endDate: '2026-11-12', windows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '20:00' }], timeZone: 'UTC', venueIds: [venue.id], durationMinutes: 60, restMinutes: 0 };
    const input = { format: 'single', playoffs: true, thirdPlace: true, availability };
    return { post, get, patch, org, league, season, open, small, empty, occupied, venue, input };
  }

  it('previews shared rounds, skips existing and empty divisions, and saves atomically', async () => {
    const f = await fixture();
    const other = await login();
    const base = `/seasons/${f.season.id}/schedule`;
    await f.get(`${base}/status`, other).expect(404);
    await f.post(`${base}/preview`, f.input, other).expect(404);
    await f.post(`${base}/estimate`, f.input, other).expect(404);
    await f.post(`${base}/calendar`, { availability: f.input.availability }, other).expect(404);
    const estimate = (await f.post(`${base}/estimate`, f.input).expect(201)).body;
    expect(estimate).toMatchObject({ required: 9, capacity: 35 });
    expect(estimate.divisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.open.id, gameCount: 6 }),
      expect.objectContaining({ id: f.small.id, gameCount: 3 }),
      expect.objectContaining({ id: f.occupied.id, reason: expect.any(String), gameCount: 0 }),
    ]));
    const calendar = (await f.post(`${base}/calendar`, { availability: f.input.availability }).expect(201)).body;
    expect(calendar.games).toEqual([expect.objectContaining({ divisionName: 'Existing', venueId: f.venue.id })]);
    const preview = (await f.post(`${base}/preview`, f.input).expect(201)).body;
    expect(preview.games).toHaveLength(9);
    expect(preview.divisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.empty.id, reason: expect.any(String) }),
      expect.objectContaining({ id: f.occupied.id, reason: expect.any(String) }),
      expect.objectContaining({ id: f.small.id, playoffs: false, notice: expect.any(String) }),
      expect.objectContaining({ id: f.open.id, playoffs: true }),
    ]));
    const games: PreviewGame[] = preview.games;
    expect(new Set(games.map((game) => `${game.scheduledAt}:${game.venueId}`)).size).toBe(9);
    expect(games.every((game) => game.scheduledAt !== '2026-11-10T08:00:00.000Z')).toBe(true);
    for (const round of [1, 2]) {
      const current = games.filter((game) => game.round === round);
      const next = games.filter((game) => game.round === round + 1);
      expect(Math.max(...current.map((game) => Date.parse(game.scheduledAt) + 60 * 60_000))).toBeLessThanOrEqual(Math.min(...next.map((game) => Date.parse(game.scheduledAt))));
    }
    const double = (await f.post(`${base}/preview`, { ...f.input, format: 'double' }).expect(201)).body;
    expect(double.games).toHaveLength(18);
    const divisionIds = [f.open.id, f.small.id];
    const payload = { ...f.input, games, divisionIds };
    const edited = games.map((game) => ({ ...game, scheduledAt: games[0].scheduledAt }));
    await f.post(`${base}/validate`, payload, other).expect(404);
    expect((await f.post(`${base}/validate`, payload).expect(201)).body.issues).toEqual([]);
    const issues = (await f.post(`${base}/validate`, { ...payload, games: edited }).expect(201)).body.issues;
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0 }), expect.objectContaining({ index: 1 })]));
    await f.post(base, { ...payload, games: edited }).expect(400);
    expect((await f.get(`/seasons/${f.season.id}/games?scope=season`).expect(200)).body.total).toBe(1);
    const saves = await Promise.all([f.post(base, payload), f.post(base, payload)]);
    expect(saves.map((response) => response.status).sort()).toEqual([201, 400]);
    const all = (await f.get(`/seasons/${f.season.id}/games?scope=season&pageSize=100`).expect(200)).body;
    expect(all.total).toBe(10);
    expect(all.items.every((game: { division_name: string }) => !!game.division_name)).toBe(true);
    expect((await f.get(`/seasons/${f.season.id}/games?divisionId=${f.small.id}&pageSize=100`).expect(200)).body.total).toBe(3);
    await f.get(`/seasons/${f.season.id}/games?scope=season&divisionId=${f.small.id}`).expect(400);
  });

  it('rejects stale previews and missing capacity without inserting games', async () => {
    const f = await fixture(); const base = `/seasons/${f.season.id}/schedule`;
    const preview = (await f.post(`${base}/preview`, f.input).expect(201)).body;
    await f.post(`/leagues/${f.league.id}/teams`, { name: 'New team', seasonId: f.season.id, divisionId: f.empty.id }).expect(201);
    await f.post(`/leagues/${f.league.id}/teams`, { name: 'Other new team', seasonId: f.season.id, divisionId: f.empty.id }).expect(201);
    await f.post(base, { ...f.input, games: preview.games, divisionIds: [f.open.id, f.small.id] }).expect(400);
    await f.post(`${base}/preview`, { ...f.input, availability: { ...f.input.availability, endDate: '2026-11-10', windows: [{ weekdays: [2], startTime: '08:00', endTime: '09:00' }] } }).expect(400);
    expect((await f.get(`/seasons/${f.season.id}/games?scope=season`).expect(200)).body.total).toBe(1);
  });

  it('schedules a whole playoff bracket in every ready division and fills it from results', async () => {
    const f = await fixture(); const base = `/seasons/${f.season.id}/schedule`;
    const openTeams = (await f.get(`/seasons/${f.season.id}/teams?divisionId=${f.open.id}`).expect(200)).body;
    await f.post(`/seasons/${f.season.id}/teams`, { teamId: openTeams[0].team_id, divisionId: f.small.id }).expect(201);
    const preview = (await f.post(`${base}/preview`, f.input).expect(201)).body;
    await f.post(base, { ...f.input, games: preview.games, divisionIds: [f.open.id, f.small.id] }).expect(201);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'active' }).expect(201);
    const games = (await f.get(`/seasons/${f.season.id}/games?scope=season&pageSize=100`).expect(200)).body.items;
    for (const game of games.filter((item: { division_id: string }) => item.division_id !== f.occupied.id)) await f.post(`/games/${game.id}/score`, { homeScore: 20, awayScore: 10 }).expect(201);
    const lateGame = games.find((item: { division_id: string }) => item.division_id === f.occupied.id);
    const lastPreliminaryGameAt = '2026-11-14T16:30:00.000Z'; // November 15 in Manila.
    const lateGameSettings = { homeTeamId: lateGame.home_season_team_id, awayTeamId: lateGame.away_season_team_id, venueId: f.venue.id };
    await f.patch(`/leagues/${f.league.id}`, { name: f.league.name, timeZone: 'Asia/Manila' }).expect(200);
    await f.patch(`/games/${lateGame.id}`, { ...lateGameSettings, scheduledAt: lastPreliminaryGameAt }).expect(200);
    expect((await f.get(`${base}/status`).expect(200)).body.lastPreliminaryGameAt).toBe(lastPreliminaryGameAt);
    const playoffs = `/seasons/${f.season.id}/playoffs`;
    const availability = { ...f.input.availability, startDate: '2026-11-16', endDate: '2026-11-18', timeZone: 'Asia/Manila' };
    const overlapping = { ...availability, startDate: '2026-11-15' };
    const wrongZone = await f.post(`${playoffs}/preview`, { availability: { ...overlapping, timeZone: 'UTC' } }).expect(400);
    expect(wrongZone.body.message).toMatch(/league time zone/);
    const playoffEstimate = (await f.post(`${playoffs}/estimate`, { availability }).expect(201)).body;
    expect(playoffEstimate.required).toBe(8);
    const next = (await f.post(`${playoffs}/preview`, { availability }).expect(201)).body;
    expect(next.games).toHaveLength(8);
    for (const division of [f.open, f.small]) expect(next.games.filter((game: PreviewGame) => game.divisionId === division.id).map((game: PreviewGame) => game.stage).sort()).toEqual(['final', 'semifinal', 'semifinal', 'third_place']);
    const payload = { availability, divisionIds: [f.open.id, f.small.id], games: next.games };
    for (const action of ['estimate', 'preview', 'validate', 'suggest', ''] as const) {
      const body = action === 'estimate' || action === 'preview' ? { availability: overlapping }
        : { ...payload, availability: overlapping, ...(action === 'suggest' ? { target: { index: 0 } } : {}) };
      const result = await f.post(action ? `${playoffs}/${action}` : playoffs, body).expect(400);
      expect(result.body.message).toMatch(/after the last elimination game.*2026-11-15/);
    }
    await f.post(`${playoffs}/estimate`, { availability: { ...availability, endDate: '2026-11-15' } }).expect(400);
    expect((await f.post(`${playoffs}/validate`, payload).expect(201)).body.issues).toEqual([]);
    await f.patch(`/games/${lateGame.id}`, { ...lateGameSettings, scheduledAt: '2026-11-15T16:30:00.000Z' }).expect(200);
    const stale = await f.post(playoffs, payload).expect(400);
    expect(stale.body.message).toMatch(/after the last elimination game.*2026-11-16/);
    await f.patch(`/games/${lateGame.id}`, { ...lateGameSettings, scheduledAt: lastPreliminaryGameAt }).expect(200);
    await f.post(playoffs, payload).expect(201);
    const after = (await f.get(`/seasons/${f.season.id}/games?scope=season&pageSize=100`).expect(200)).body.items;
    const waiting = after.filter((game: { stage: string }) => game.stage === 'final' || game.stage === 'third_place');
    expect(waiting).toHaveLength(4);
    expect(waiting.every((game: { home_season_team_id: string | null; home_name: string }) => game.home_season_team_id === null && / (winner|loser)$/.test(game.home_name))).toBe(true);
    const status = (await f.get(`/seasons/${f.season.id}/schedule/status`).expect(200)).body;
    expect(status.divisions.find((division: { id: string }) => division.id === f.open.id)).toMatchObject({ playoffStage: null, playoffReason: 'Playoff games are already scheduled.' });
    const semifinals = after.filter((game: { stage: string; division_id: string }) => game.stage === 'semifinal' && game.division_id === f.small.id);
    for (const game of semifinals) await f.post(`/games/${game.id}/score`, { homeScore: 20, awayScore: 10 }).expect(201);
    const filled = (await f.get(`/seasons/${f.season.id}/games?divisionId=${f.small.id}&pageSize=100`).expect(200)).body.items;
    const final = filled.find((game: { stage: string }) => game.stage === 'final');
    expect(new Set([final.home_season_team_id, final.away_season_team_id])).toEqual(new Set(semifinals.map((game: { home_season_team_id: string }) => game.home_season_team_id)));
  });
});
