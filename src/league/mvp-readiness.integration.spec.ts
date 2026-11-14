import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('mistake recovery, league time zones and account settings', () => {
  let app: INestApplication;
  let db: DatabaseService;
  const emails: { email: string; purpose: string; token: string }[] = [];
  const notices: { email: string; subject: string }[] = [];
  const password = 'correct-horse-battery-123';
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer).useValue({
      send: async (email: string, purpose: string, token: string) => { emails.push({ email, purpose, token }); },
      notice: async (email: string, subject: string) => { notices.push({ email, subject }); },
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = module.get(DatabaseService);
    await db.db.deleteFrom('auth.rate_limits').execute();
  });
  afterAll(async () => { await app?.close(); });
  const server = () => app.getHttpServer();
  async function signIn(email = `${randomUUID()}@example.test`) {
    await request(server()).post('/auth/register').send({ email, password }).expect(200);
    await request(server()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email && e.purpose === 'verify')!.token }).expect(200);
    const body = (await request(server()).post('/auth/login').send({ email, password }).expect(200)).body;
    return { email, auth: `Bearer ${body.accessToken}` };
  }
  function client(auth: string) {
    return {
      get: (url: string) => request(server()).get(`/league${url}`).set('Authorization', auth),
      post: (url: string, body: object = {}) => request(server()).post(`/league${url}`).set('Authorization', auth).send(body),
      patch: (url: string, body: object) => request(server()).patch(`/league${url}`).set('Authorization', auth).send(body),
      del: (url: string, body?: object) => { const call = request(server()).delete(`/league${url}`).set('Authorization', auth); return body ? call.send(body) : call; },
    };
  }
  async function leagueWithSeason(api: ReturnType<typeof client>, names = { org: 'Org', league: 'League', season: 'Season' }) {
    const org = (await api.post('/organizations', { name: names.org }).expect(201)).body;
    const league = (await api.post(`/organizations/${org.id}/leagues`, { name: names.league }).expect(201)).body;
    const season = (await api.post(`/leagues/${league.id}/seasons`, { name: names.season }).expect(201)).body;
    await api.post(`/leagues/${league.id}/teams`, { name: 'Hawks', seasonId: season.id }).expect(201);
    await api.post(`/leagues/${league.id}/teams`, { name: 'Bears', seasonId: season.id }).expect(201);
    const [home, away] = (await api.get(`/seasons/${season.id}/teams`).expect(200)).body;
    const game = (await api.post(`/seasons/${season.id}/games`, { homeTeamId: home.id, awayTeamId: away.id, scheduledAt: '2027-01-09T10:00:00Z' }).expect(201)).body;
    return { org, league, season, home, away, game };
  }

  it('deletes unused seasons with a typed name and requires archiving once results exist', async () => {
    const api = client((await signIn()).auth);
    const { season, game } = await leagueWithSeason(api);
    await api.del(`/seasons/${season.id}`, { confirmName: 'Wrong' }).expect(400);
    await api.post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    await api.post(`/seasons/${season.id}/status`, { status: 'draft' }).expect(201);
    await api.post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    await api.post(`/games/${game.id}/score`, { homeScore: 70, awayScore: 60 }).expect(201);
    await api.post(`/seasons/${season.id}/status`, { status: 'draft' }).expect(400);
    expect((await api.del(`/seasons/${season.id}`, { confirmName: 'Season' }).expect(409)).body.message).toMatch(/Archive it instead/);
    await api.post(`/seasons/${season.id}/archive`).expect(201);
    await api.post(`/seasons/${season.id}/divisions`, { name: 'Late' }).expect(409);
    await api.post(`/games/${game.id}/score`, { homeScore: 71, awayScore: 60 }).expect(409);
    await api.get(`/seasons/${season.id}/games`).expect(200);
    await api.del(`/seasons/${season.id}`, { confirmName: 'Season' }).expect(200);
    expect(await db.db.selectFrom('league.games').select('id').where('season_id', '=', season.id).execute()).toEqual([]);

    const unused = await leagueWithSeason(api, { org: 'Second', league: 'Fresh league', season: 'Fresh season' });
    await api.del(`/seasons/${unused.season.id}`, { confirmName: 'Fresh season' }).expect(200);
    await api.get(`/seasons/${unused.season.id}`).expect(404);
  });

  it('hides archived leagues and seasons, restores them in order and permanently deletes from the archive', async () => {
    const owner = await signIn();
    const api = client(owner.auth);
    const { org, league, season, game } = await leagueWithSeason(api);
    await api.post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    await api.post(`/games/${game.id}/score`, { homeScore: 70, awayScore: 60 }).expect(201);
    const shared = (await api.post(`/organizations/${org.id}/players`, { firstName: 'Shared', lastName: 'Player', dateOfBirth: '2000-01-01' }).expect(201)).body;
    const otherOrg = (await api.post('/organizations', { name: 'Other org' }).expect(201)).body;
    await db.db.insertInto('league.organization_players').values({ organization_id: otherOrg.id, player_id: shared.id }).execute();

    await api.del(`/leagues/${league.id}`, { confirmName: 'League' }).expect(409);
    await api.post(`/leagues/${league.id}/archive`).expect(201);
    expect((await api.get(`/organizations/${org.id}/leagues`).expect(200)).body).toEqual([]);
    expect((await api.get(`/organizations/${org.id}/leagues?archived=true`).expect(200)).body).toEqual([expect.objectContaining({ id: league.id })]);
    expect((await api.get(`/organizations/${org.id}/seasons?page=1&pageSize=10`).expect(200)).body.total).toBe(0);
    expect((await api.get(`/organizations/${org.id}/seasons?page=1&pageSize=10&archived=true`).expect(200)).body.total).toBe(1);
    await api.post(`/leagues/${league.id}/venues`, { name: 'Gym' }).expect(409);
    await api.post(`/seasons/${season.id}/archive`).expect(201);
    expect((await api.post(`/seasons/${season.id}/restore`).expect(409)).body.message).toBe('Restore the league first');
    await api.post(`/leagues/${league.id}/restore`).expect(201);
    await api.post(`/seasons/${season.id}/restore`).expect(201);
    expect((await api.get(`/leagues/${league.id}/seasons`).expect(200)).body).toEqual([expect.objectContaining({ id: season.id })]);

    await api.post(`/organizations/${org.id}/archive`).expect(201);
    expect((await api.get('/organizations').expect(200)).body.map((item: { id: string }) => item.id)).not.toContain(org.id);
    expect((await api.get('/organizations?archived=true').expect(200)).body).toEqual([expect.objectContaining({ id: org.id })]);
    await api.del(`/organizations/${org.id}`, { confirmName: 'Org' }).expect(200);
    expect(await db.db.selectFrom('league.leagues').select('id').where('organization_id', '=', org.id).execute()).toEqual([]);
    expect(await db.db.selectFrom('league.players').select('id').where('id', '=', shared.id).execute()).toHaveLength(1);
  });

  it('deletes teams, players and venues only when nothing depends on them', async () => {
    const api = client((await signIn()).auth);
    const { org, league, season, home } = await leagueWithSeason(api);
    const venue = (await api.post(`/leagues/${league.id}/venues`, { name: 'Gym' }).expect(201)).body;
    const unusedVenue = (await api.post(`/leagues/${league.id}/venues`, { name: 'Spare' }).expect(201)).body;
    const game = (await api.get(`/seasons/${season.id}/games`).expect(200)).body[0];
    await api.patch(`/games/${game.id}`, { homeTeamId: game.home_season_team_id, awayTeamId: game.away_season_team_id, scheduledAt: '2027-01-10T10:00:00Z', venueId: venue.id }).expect(200);
    await api.del(`/venues/${venue.id}`).expect(409);
    await api.del(`/venues/${unusedVenue.id}`).expect(200);
    await api.del(`/teams/${home.team_id}`).expect(409);
    await api.post(`/leagues/${league.id}/teams`, { name: 'Spare team', seasonId: season.id }).expect(201);
    const spare = (await api.get(`/seasons/${season.id}/teams`).expect(200)).body.find((team: { name: string }) => team.name === 'Spare team');
    const player = (await api.post(`/organizations/${org.id}/players`, { firstName: 'Draft', lastName: 'Player', dateOfBirth: '2000-01-01' }).expect(201)).body;
    await api.post(`/season-teams/${spare.id}/roster`, { playerId: player.id }).expect(201);
    await api.del(`/teams/${spare.team_id}`).expect(200);
    expect(await db.db.selectFrom('league.rosters').select('id').where('player_id', '=', player.id).execute()).toEqual([]);
    const active = (await api.post(`/organizations/${org.id}/players`, { firstName: 'Active', lastName: 'Player', dateOfBirth: '2000-01-01' }).expect(201)).body;
    await api.post(`/season-teams/${home.id}/roster`, { playerId: active.id }).expect(201);
    await api.post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    await api.del(`/organizations/${org.id}/players/${active.id}`).expect(409);
    await api.del(`/organizations/${org.id}/players/${player.id}`).expect(200);
    expect(await db.db.selectFrom('league.players').select('id').where('id', '=', player.id).execute()).toEqual([]);
  });

  it('stores a valid league time zone', async () => {
    const api = client((await signIn()).auth);
    const org = (await api.post('/organizations', { name: 'Zones' }).expect(201)).body;
    await api.post(`/organizations/${org.id}/leagues`, { name: 'Bad', timeZone: 'Mars/Olympus' }).expect(400);
    const league = (await api.post(`/organizations/${org.id}/leagues`, { name: 'Manila', timeZone: 'Asia/Manila' }).expect(201)).body;
    expect(league.time_zone).toBe('Asia/Manila');
    expect((await api.patch(`/leagues/${league.id}`, { name: 'Manila', location: null }).expect(200)).body.time_zone).toBe('Asia/Manila');
    expect((await api.patch(`/leagues/${league.id}`, { name: 'Manila', timeZone: 'America/New_York' }).expect(200)).body.time_zone).toBe('America/New_York');
  });

  it('updates the profile, changes the password and signs out other devices', async () => {
    const { email, auth } = await signIn();
    const second = `Bearer ${(await request(server()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}`;
    expect((await request(server()).patch('/auth/me').set('Authorization', auth).send({ name: ' Coach ' }).expect(200)).body.user.name).toBe('Coach');
    await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: 'wrong-password', newPassword: 'another-long-password-1' }).expect(400);
    await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: password, newPassword: 'short' }).expect(400);
    await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: password, newPassword: 'another-long-password-1' }).expect(200);
    await request(server()).get('/auth/me').set('Authorization', auth).expect(200);
    await request(server()).get('/auth/me').set('Authorization', second).expect(401);
    await request(server()).post('/auth/login').send({ email, password: 'another-long-password-1' }).expect(200);
    const third = `Bearer ${(await request(server()).post('/auth/login').send({ email, password: 'another-long-password-1' }).expect(200)).body.accessToken}`;
    await request(server()).post('/auth/sign-out-others').set('Authorization', auth).expect(200);
    await request(server()).get('/auth/me').set('Authorization', third).expect(401);
    await request(server()).get('/auth/me').set('Authorization', auth).expect(200);
  });

  it('changes email only after confirmation and protects against a taken address', async () => {
    const { email, auth } = await signIn();
    const target = `${randomUUID()}@example.test`;
    await request(server()).post('/auth/change-email').set('Authorization', auth).send({ newEmail: target, currentPassword: 'wrong-password' }).expect(400);
    await request(server()).post('/auth/change-email').set('Authorization', auth).send({ newEmail: target, currentPassword: password }).expect(200);
    const link = emails.find((item) => item.email === target && item.purpose === 'email_change')!;
    expect((await request(server()).get('/auth/me').set('Authorization', auth).expect(200)).body.user.email).toBe(email);
    await request(server()).post('/auth/confirm-email-change').send({ token: link.token }).expect(200);
    expect((await request(server()).get('/auth/me').set('Authorization', auth).expect(200)).body.user.email).toBe(target);
    expect(notices).toContainEqual(expect.objectContaining({ email }));
    await request(server()).post('/auth/confirm-email-change').send({ token: link.token }).expect(400);

    const racer = await signIn();
    const contested = `${randomUUID()}@example.test`;
    await request(server()).post('/auth/change-email').set('Authorization', racer.auth).send({ newEmail: contested, currentPassword: password }).expect(200);
    const pending = emails.find((item) => item.email === contested && item.purpose === 'email_change')!;
    await signIn(contested);
    await request(server()).post('/auth/confirm-email-change').send({ token: pending.token }).expect(409);
  });

  it('blocks account deletion while the user owns organizations', async () => {
    const { auth } = await signIn();
    const api = client(auth);
    const org = (await api.post('/organizations', { name: 'Mine' }).expect(201)).body;
    await request(server()).delete('/auth/me').set('Authorization', auth).send({ password: 'wrong-password' }).expect(400);
    expect((await request(server()).delete('/auth/me').set('Authorization', auth).send({ password }).expect(409)).body.message).toBe('Delete your organizations first');
    await api.del(`/organizations/${org.id}`, { confirmName: 'Mine' }).expect(200);
    await request(server()).delete('/auth/me').set('Authorization', auth).send({ password }).expect(200);
    await request(server()).get('/auth/me').set('Authorization', auth).expect(401);
  });
});

