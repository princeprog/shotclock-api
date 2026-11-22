import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('scorekeeper invitations against isolated PostgreSQL', () => {
  let app: INestApplication;
  const emails: { email: string; token: string }[] = [];
  const invitations: { email: string; token: string }[] = [];
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer).useValue({
      send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); },
      notice: async () => {},
      sendInvitation: async (email: string, _league: string, _inviter: string, token: string) => { invitations.push({ email, token }); },
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  async function account(email = `${randomUUID()}@example.test`) {
    const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email)!.token }).expect(200);
    return { email, auth: `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}` };
  }
  const latest = (email: string) => [...invitations].reverse().find((item) => item.email === email)!.token;

  it('invites, accepts, lists and removes scorekeepers for one league only', async () => {
    const owner = await account();
    const post = (url: string, body: object, auth = owner.auth) => request(app.getHttpServer()).post(url).set('Authorization', auth).send(body);
    const get = (url: string, auth = owner.auth) => request(app.getHttpServer()).get(url).set('Authorization', auth);
    const del = (url: string, auth = owner.auth) => request(app.getHttpServer()).delete(url).set('Authorization', auth);
    const org = (await post('/league/organizations', { name: 'Scorekeeping org' }).expect(201)).body;
    const league = (await post(`/league/organizations/${org.id}/leagues`, { name: 'Scored league' }).expect(201)).body;
    const other = (await post(`/league/organizations/${org.id}/leagues`, { name: 'Other league' }).expect(201)).body;
    const season = (await post(`/league/leagues/${league.id}/seasons`, { name: 'Season', startDate: '2026-01-01' }).expect(201)).body;

    const keeperEmail = `keeper-${randomUUID()}@example.test`;
    await post(`/league/leagues/${league.id}/invitations`, { email: owner.email.toUpperCase() }).expect(400);
    const invitation = (await post(`/league/leagues/${league.id}/invitations`, { email: keeperEmail.toUpperCase() }).expect(201)).body;
    expect(invitation.email).toBe(keeperEmail);
    const firstToken = latest(keeperEmail);
    await post(`/league/leagues/${league.id}/invitations`, { email: keeperEmail }).expect(201);
    const token = latest(keeperEmail);
    expect(token).not.toBe(firstToken);
    await request(app.getHttpServer()).post('/invitations/lookup').send({ token: firstToken }).expect(404);
    expect((await request(app.getHttpServer()).post('/invitations/lookup').send({ token }).expect(201)).body).toEqual({ leagueName: 'Scored league', organizationName: 'Scorekeeping org', email: keeperEmail, status: 'pending' });
    expect((await get(`/league/leagues/${league.id}/scorekeepers`).expect(200)).body.invitations).toEqual([expect.objectContaining({ id: invitation.id, email: keeperEmail })]);

    const stranger = await account();
    await post('/league/invitations/accept', { token }, stranger.auth).expect(409);
    const keeper = await account(keeperEmail);
    await get(`/league/leagues/${league.id}/scorekeepers`, keeper.auth).expect(404);
    expect((await post('/league/invitations/accept', { token }, keeper.auth).expect(201)).body).toEqual({ leagueId: league.id, leagueName: 'Scored league' });
    await post('/league/invitations/accept', { token }, keeper.auth).expect(409);
    expect((await request(app.getHttpServer()).post('/invitations/lookup').send({ token }).expect(201)).body.status).toBe('accepted');
    await post(`/league/leagues/${league.id}/invitations`, { email: keeperEmail }).expect(409);

    const listed = (await get(`/league/leagues/${league.id}/scorekeepers`).expect(200)).body;
    expect(listed.invitations).toEqual([]);
    expect(listed.members).toEqual([expect.objectContaining({ email: keeperEmail })]);
    expect((await get('/league/scorekeeping/games', keeper.auth).expect(200)).body.leagues).toEqual([expect.objectContaining({ id: league.id, role: 'scorekeeper' })]);
    expect((await get('/league/scorekeeping/games').expect(200)).body.leagues.map((item: { id: string }) => item.id).sort()).toEqual([league.id, other.id].sort());
    await get(`/league/seasons/${season.id}`, keeper.auth).expect(404);
    await get(`/league/leagues/${other.id}/scorekeepers`, keeper.auth).expect(404);
    await del(`/league/league-members/${listed.members[0].id}`, keeper.auth).expect(404);

    await del(`/league/league-members/${listed.members[0].id}`).expect(200);
    expect((await get('/league/scorekeeping/games', keeper.auth).expect(200)).body).toEqual({ leagues: [], games: [] });
  });

  it('rejects revoked and expired invitations', async () => {
    const owner = await account();
    const post = (url: string, body: object, auth = owner.auth) => request(app.getHttpServer()).post(url).set('Authorization', auth).send(body);
    const org = (await post('/league/organizations', { name: 'Invites org' }).expect(201)).body;
    const league = (await post(`/league/organizations/${org.id}/leagues`, { name: 'Invites league' }).expect(201)).body;
    const revokedEmail = `revoked-${randomUUID()}@example.test`;
    const revoked = (await post(`/league/leagues/${league.id}/invitations`, { email: revokedEmail }).expect(201)).body;
    await request(app.getHttpServer()).delete(`/league/invitations/${revoked.id}`).set('Authorization', owner.auth).expect(200);
    await request(app.getHttpServer()).delete(`/league/invitations/${revoked.id}`).set('Authorization', owner.auth).expect(409);
    const revokedKeeper = await account(revokedEmail);
    await post('/league/invitations/accept', { token: latest(revokedEmail) }, revokedKeeper.auth).expect(409);

    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expired = (await post(`/league/leagues/${league.id}/invitations`, { email: expiredEmail }).expect(201)).body;
    await app.get(DatabaseService).db.updateTable('league.invitations').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', expired.id).execute();
    expect((await request(app.getHttpServer()).post('/invitations/lookup').send({ token: latest(expiredEmail) }).expect(201)).body.status).toBe('expired');
    const expiredKeeper = await account(expiredEmail);
    await post('/league/invitations/accept', { token: latest(expiredEmail) }, expiredKeeper.auth).expect(409);
    await request(app.getHttpServer()).post('/invitations/lookup').send({ token: 'short' }).expect(400);
  });
});

