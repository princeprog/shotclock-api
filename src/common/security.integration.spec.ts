import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('security events and rate limits', () => {
  let app: INestApplication;
  let db: DatabaseService;
  const emails: { email: string; purpose: string; token: string }[] = [];
  const notices: { email: string; subject: string }[] = [];
  const password = 'correct-horse-battery-123';
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    process.env.LEAGUE_RATE_LIMIT_SCHEDULE = '3';
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
  afterAll(async () => { delete process.env.LEAGUE_RATE_LIMIT_SCHEDULE; await app?.close(); });
  const server = () => app.getHttpServer();
  const events = (userId: string) => db.db.selectFrom('auth.security_events').select(['event', 'metadata', 'user_id']).where('user_id', '=', userId).orderBy('created_at').execute();
  async function signIn() {
    const email = `${randomUUID()}@example.test`;
    await request(server()).post('/auth/register').send({ email, password }).expect(200);
    await request(server()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email && e.purpose === 'verify')!.token }).expect(200);
    const body = (await request(server()).post('/auth/login').send({ email, password }).expect(200)).body;
    return { email, id: body.user.id as string, auth: `Bearer ${body.accessToken}` };
  }

  it('records sign-ins with hashed emails and account changes, and emails a password notice', async () => {
    const { email, id, auth } = await signIn();
    await request(server()).post('/auth/login').send({ email, password: 'wrong-password-123' }).expect(401);
    const stranger = `${randomUUID()}@example.test`;
    await request(server()).post('/auth/login').send({ email: stranger, password }).expect(401);
    const unknown = await db.db.selectFrom('auth.security_events').select(['metadata', 'user_id']).where('event', '=', 'login_failed').where('user_id', 'is', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(unknown.metadata).toEqual({ emailHash: createHash('sha256').update(stranger).digest('hex') });
    expect(JSON.stringify(unknown)).not.toContain(stranger);
    await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: password, newPassword: 'another-long-password-1' }).expect(200);
    expect(notices).toContainEqual({ email, subject: 'Your Shotclock password was changed' });
    const org = (await request(server()).post('/league/organizations').set('Authorization', auth).send({ name: 'Audit' }).expect(201)).body;
    await request(server()).post(`/league/organizations/${org.id}/archive`).set('Authorization', auth).send({}).expect(201);
    await request(server()).delete(`/league/organizations/${org.id}`).set('Authorization', auth).send({ confirmName: 'Audit' }).expect(200);
    expect((await events(id)).map((row) => row.event)).toEqual(['login_succeeded', 'login_failed', 'password_changed', 'organization_archived', 'organization_deleted']);
    await request(server()).delete('/auth/me').set('Authorization', auth).send({ password: 'another-long-password-1' }).expect(200);
    expect(await events(id)).toEqual([]);
    const deleted = await db.db.selectFrom('auth.security_events').select('metadata').where('event', '=', 'account_deleted').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(deleted.metadata).toEqual({ accountId: id });
  });

  it('limits current-password checks per account', async () => {
    const { auth } = await signIn();
    for (let attempt = 0; attempt < 10; attempt++) await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: 'wrong-password-123', newPassword: 'another-long-password-1' }).expect(400);
    await request(server()).post('/auth/change-password').set('Authorization', auth).send({ currentPassword: password, newPassword: 'another-long-password-1' }).expect(429);
  });

  it('limits schedule planning per user', async () => {
    const { auth } = await signIn();
    const seasonId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) await request(server()).post(`/league/seasons/${seasonId}/schedule/estimate`).set('Authorization', auth).send({}).expect(400);
    await request(server()).post(`/league/seasons/${seasonId}/schedule/estimate`).set('Authorization', auth).send({}).expect(429);
    await request(server()).get('/league/organizations').set('Authorization', auth).expect(200);
  });
});

