import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('organization team pagination against disposable PostgreSQL', () => {
  let app: INestApplication;
  let owner: string; let other: string;
  let org: string; let league: string; let season: string; let nextSeason: string;
  let open: string; let youth: string; let club: string; let otherLeague: string; let otherSeason: string; let privateLeague: string; let privateSeason: string;
  const emails: { email: string; token: string }[] = [];
  const get = (query: object = {}, auth = owner) => request(app.getHttpServer()).get(`/league/organizations/${org}/teams`).set('Authorization', auth).query(query);
  const post = (path: string, body: object, auth = owner) => request(app.getHttpServer()).post(`/league${path}`).set('Authorization', auth).send(body);

  async function login() {
    const email = `${randomUUID()}@example.test`; const password = 'correct-horse-battery-123';
    const auth = app.get(AuthService);
    await auth.register(email, password);
    await auth.consumeAction(emails.find((item) => item.email === email)!.token, 'verify');
    return `Bearer ${(await auth.login(email, password)).accessToken}`;
  }

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const current = await sql<{ name: string }>`select current_database() as name`.execute(app.get(DatabaseService).db);
    if (current.rows[0].name !== process.env.DB_NAME) throw new Error('Unexpected database');
    owner = await login(); other = await login();
    org = (await post('/organizations', { name: 'Pagination' }).expect(201)).body.id;
    league = (await post(`/organizations/${org}/leagues`, { name: 'League' }).expect(201)).body.id;
    season = (await post(`/leagues/${league}/seasons`, { name: 'Same name' }).expect(201)).body.id;
    nextSeason = (await post(`/leagues/${league}/seasons`, { name: 'Same name' }).expect(201)).body.id;
    open = (await request(app.getHttpServer()).get(`/league/seasons/${season}/divisions`).set('Authorization', owner).expect(200)).body[0].id;
    youth = (await post(`/seasons/${season}/divisions`, { name: 'Youth' }).expect(201)).body.id;
    const nextOpen = (await request(app.getHttpServer()).get(`/league/seasons/${nextSeason}/divisions`).set('Authorization', owner).expect(200)).body[0].id;
    club = (await post(`/leagues/${league}/teams`, { name: 'Alpha 100%_', seasonId: season, divisionIds: [open, youth] }).expect(201)).body.id;
    await post(`/seasons/${nextSeason}/teams`, { teamId: club, divisionId: nextOpen }).expect(201);
    for (let i = 0; i < 11; i++) await post(`/leagues/${league}/teams`, { name: `Team ${String(i).padStart(2, '0')}`, seasonId: season, divisionId: open }).expect(201);
    await app.get(DatabaseService).db.insertInto('league.teams').values({ name: 'Unregistered', league_id: league, abbreviation: null }).execute();
    const secondLeague = (await post(`/organizations/${org}/leagues`, { name: 'Second league' }).expect(201)).body.id;
    await app.get(DatabaseService).db.insertInto('league.teams').values([
      { name: 'Tie', league_id: league, abbreviation: null },
      { name: 'Tie', league_id: secondLeague, abbreviation: null },
    ]).execute();
    const anotherOrg = (await post('/organizations', { name: 'Same owner, different organization' }).expect(201)).body.id;
    otherLeague = (await post(`/organizations/${anotherOrg}/leagues`, { name: 'Other league' }).expect(201)).body.id;
    otherSeason = (await post(`/leagues/${otherLeague}/seasons`, { name: 'Other season' }).expect(201)).body.id;
    const privateOrg = (await post('/organizations', { name: 'Other owner' }, other).expect(201)).body.id;
    privateLeague = (await post(`/organizations/${privateOrg}/leagues`, { name: 'Private league' }, other).expect(201)).body.id;
    privateSeason = (await post(`/leagues/${privateLeague}/seasons`, { name: 'Private season' }, other).expect(201)).body.id;
  }, 30000);
  afterAll(async () => { await app?.close(); });

  it('preserves the legacy array and expands matched clubs to every season registration', async () => {
    const all = (await get().expect(200)).body;
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(17);
    expect(all).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Unregistered', season_team_id: null })]));
    const selected = (await get({ seasonId: nextSeason }).expect(200)).body;
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((row: { season_id: string }) => row.season_id))).toEqual(new Set([season, nextSeason]));
    expect(selected.every((row: { id: string }) => row.id === club)).toBe(true);
  });

  it('filters registration rows before counting and pages ties deterministically', async () => {
    const query = { seasonId: season, leagueId: league, pageSize: 1 };
    const first = (await get({ ...query, page: 1 }).expect(200)).body;
    const second = (await get({ ...query, page: 2 }).expect(200)).body;
    expect(first).toMatchObject({ page: 1, pageSize: 1, total: 13, totalPages: 13 });
    expect(second).toMatchObject({ page: 2, pageSize: 1, total: 13, totalPages: 13 });
    expect(first.items[0].id).toBe(club); expect(second.items[0].id).toBe(club);
    expect([first.items[0].season_team_id, second.items[0].season_team_id]).toEqual([first.items[0].season_team_id, second.items[0].season_team_id].sort());
    expect(first.items[0].season_team_id).not.toBe(second.items[0].season_team_id);
    expect(first.items[0].season_id).toBe(season); expect(second.items[0].season_id).toBe(season);
    const filtered = (await get({ seasonId: season, divisionId: youth, page: 1 }).expect(200)).body;
    expect(filtered).toMatchObject({ total: 1, page: 1, pageSize: 10, totalPages: 1, items: [expect.objectContaining({ id: club, season_id: season, division_id: youth })] });
    const next = (await get({ seasonId: nextSeason, page: 1 }).expect(200)).body;
    expect(next).toMatchObject({ total: 1, items: [expect.objectContaining({ id: club, season_id: nextSeason })] });
    const clubRows = (await get({ search: 'Alpha', pageSize: 10 }).expect(200)).body.items;
    const expected = [...clubRows].sort((a, b) => a.season_id.localeCompare(b.season_id) || a.season_team_id.localeCompare(b.season_team_id));
    expect(clubRows).toEqual(expected);
    const ties = (await get({ search: 'Tie', pageSize: 10 }).expect(200)).body.items;
    expect(ties).toHaveLength(2);
    expect(ties.map((row: { id: string }) => row.id)).toEqual(ties.map((row: { id: string }) => row.id).sort());
  });

  it('handles search, defaults, clamping, empty results and unregistered teams', async () => {
    expect((await get({ search: '%_', pageSize: 10 }).expect(200)).body).toMatchObject({ total: 3, page: 1, totalPages: 1 });
    expect((await get({ search: 'aLpHa', seasonId: season, page: 1 }).expect(200)).body).toMatchObject({ total: 2, pageSize: 10 });
    expect((await get({ search: 'missing', page: 9 }).expect(200)).body).toMatchObject({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 1 });
    expect((await get({ page: 1000000, pageSize: 10 }).expect(200)).body).toMatchObject({ page: 2, total: 17, totalPages: 2 });
    expect((await get({ pageSize: 100 }).expect(200)).body).toMatchObject({ page: 1, pageSize: 100, total: 17, totalPages: 1 });
    expect((await get({ search: 'Unregistered', page: 1 }).expect(200)).body.items).toEqual([expect.objectContaining({ season_team_id: null })]);
  });

  it('validates pagination and retains ownership and cross-organization checks', async () => {
    for (const query of [{ page: 0 }, { page: 1000001 }, { page: 1.5 }, { page: 'bad' }, { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }]) await get(query).expect(400);
    await get({ page: 1 }, other).expect(404);
    await get({ leagueId: otherLeague, page: 1 }).expect(404);
    await get({ seasonId: otherSeason, page: 1 }).expect(404);
    await get({ leagueId: privateLeague, page: 1 }).expect(404);
    await get({ seasonId: privateSeason, page: 1 }).expect(404);
    await get({ leagueId: league, seasonId: otherSeason, page: 1 }).expect(404);
    await get({ divisionId: youth, page: 1 }).expect(400);
    await get({ seasonId: nextSeason, divisionId: youth, page: 1 }).expect(404);
  });
});
