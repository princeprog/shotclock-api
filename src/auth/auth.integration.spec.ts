import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import { AuthMailer } from './auth-mailer.service';
import { DatabaseService } from '../database/database.service';
import { AuthCleanup } from './auth-cleanup.service';

const describeDatabase = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '')
  ? describe : describe.skip;

describeDatabase('authentication against isolated PostgreSQL', () => {
  const emails: Array<{ email: string; purpose: string; token: string }> = [];
  let deliver: () => Promise<void> = async () => undefined;
  let app: INestApplication;
  let db: DatabaseService;
  const password = 'correct-horse-battery-123';
  const newEmail = () => `${randomUUID()}@example.test`;
  const registerAndLogin = async (email: string) => {
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    const verification = emails.find((m) => m.email === email && m.purpose === 'verify')!.token;
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: verification }).expect(200);
    return (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body;
  };

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    process.env.AUTH_TRUSTED_GATEWAY_IPS = '127.0.0.1,::1';
    process.env.AUTH_GATEWAY_SECRET = 'integration-gateway-secret-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, purpose: string, token: string) => { emails.push({ email, purpose, token }); await deliver(); } })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = module.get(DatabaseService);
    await db.db.deleteFrom('auth.rate_limits').execute();
  });
  afterAll(async () => { await app?.close(); });

  it('registers, verifies, rotates, commits replay revocation, and logs out', async () => {
    const email = newEmail();
    const registration = await request(app.getHttpServer()).post('/auth/register').send({ email, password, name: 'Player' }).expect(200);
    expect(registration.body).not.toHaveProperty('accessToken');
    const duplicate = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    expect(duplicate.body).toEqual(registration.body);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(401);
    const stored = await db.db.selectFrom('auth.users').select('password_hash').where('email', '=', email).executeTakeFirstOrThrow();
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.password_hash).not.toContain(password);
    const verification = emails.find((m) => m.email === email && m.purpose === 'verify')!.token;
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: verification }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: verification }).expect(400);
    const created = (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body;
    expect(created.user).toMatchObject({ email, name: 'Player', emailVerified: true });
    expect(created.user).not.toHaveProperty('password_hash');
    const claims = JSON.parse(Buffer.from(created.accessToken.split('.')[1], 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(15 * 60);
    const me = await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${created.accessToken}`).expect(200);
    expect(me.body.user.emailVerified).toBe(true);
    const rotated = await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(200);
    expect(rotated.body.refreshToken).not.toBe(created.refreshToken);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').send({ refreshToken: login.body.refreshToken }).expect(204);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
  });

  it('serializes simultaneous refreshes and revokes the winning session on replay', async () => {
    const created = await registerAndLogin(newEmail());
    const send = () => request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.status === 200)!;
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${winner.body.accessToken}`).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: winner.body.refreshToken }).expect(401);
  });

  it('uses generic recovery responses, resets once, and invalidates sessions', async () => {
    const email = newEmail();
    const created = await registerAndLogin(email);
    const known = await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
    const unknown = await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: newEmail() }).expect(200);
    expect(known.body).toEqual(unknown.body);
    const reset = emails.find((m) => m.email === email && m.purpose === 'reset')!.token;
    const next = 'new-correct-password-456';
    await request(app.getHttpServer()).post('/auth/reset-password').send({ token: reset, password: next }).expect(200);
    await request(app.getHttpServer()).post('/auth/reset-password').send({ token: reset, password: next }).expect(400);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${created.accessToken}`).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: next }).expect(200);
  });

  it('does not wait for SMTP when the account exists', async () => {
    const email = newEmail();
    await registerAndLogin(email);
    let release = () => {};
    deliver = () => new Promise<void>((resolve) => { release = resolve; });
    try {
      const response = await Promise.race([
        request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).then((r) => r.status),
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 2000)),
      ]);
      expect(response).toBe(200);
    } finally {
      release();
      deliver = async () => undefined;
    }
  });

  it('validates input and enforces account throttling independent of forwarded headers', async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email: 'bad', password: 'short' }).expect(400);
    await request(app.getHttpServer()).post('/auth/register').send({ email: newEmail(), password, extra: true }).expect(400);
    const email = newEmail();
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer()).post('/auth/forgot-password').set('X-Forwarded-For', `192.0.2.${i}`).send({ email }).expect(200);
    }
    await request(app.getHttpServer()).post('/auth/forgot-password').set('X-Forwarded-For', '192.0.2.99').send({ email }).expect(429);
  });

  it('rejects sessions beyond their idle or absolute expiration', async () => {
    const created = await registerAndLogin(newEmail());
    await db.db.updateTable('auth.sessions').set({ idle_expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', created.user.id).execute();
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(401);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${created.accessToken}`).expect(401);
    const absolute = await registerAndLogin(newEmail());
    await db.db.updateTable('auth.sessions').set({ absolute_expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', absolute.user.id).execute();
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: absolute.refreshToken }).expect(401);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${absolute.accessToken}`).expect(401);
  });

  it('extends idle expiry without exceeding the absolute session limit', async () => {
    const created = await registerAndLogin(newEmail());
    const absolute = new Date(Date.now() + 2 * 86_400_000);
    await db.db.updateTable('auth.sessions')
      .set({ idle_expires_at: new Date(Date.now() + 60_000), absolute_expires_at: absolute })
      .where('user_id', '=', created.user.id).execute();
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(200);
    const session = await db.db.selectFrom('auth.sessions').select(['idle_expires_at', 'absolute_expires_at'])
      .where('user_id', '=', created.user.id).executeTakeFirstOrThrow();
    expect(session.idle_expires_at.getTime()).toBe(session.absolute_expires_at.getTime());
  });

  it('rejects expired verification tokens and supports bearer logout', async () => {
    const email = newEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    const verification = emails.find((m) => m.email === email && m.purpose === 'verify')!.token;
    await db.db.updateTable('auth.action_tokens').set({ expires_at: new Date(Date.now() - 1000) })
      .where('token_hash', '=', createHash('sha256').update(verification).digest('hex')).execute();
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: verification }).expect(400);
    const created = await registerAndLogin(newEmail());
    await request(app.getHttpServer()).post('/auth/logout').set('Authorization', `Bearer ${created.accessToken}`).expect(204);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(401);
  });

  it('allows logout using a refresh token when the access token is expired', async () => {
    const created = await registerAndLogin(newEmail());
    const claims = JSON.parse(Buffer.from(created.accessToken.split('.')[1], 'base64url').toString());
    const expired = await app.get(JwtService).signAsync({ sub: claims.sub, sid: claims.sid, typ: 'access' },
      { secret: process.env.AUTH_JWT_SECRET!, algorithm: 'HS256', expiresIn: '-1s' });
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
    await request(app.getHttpServer()).post('/auth/logout').set('Authorization', `Bearer ${expired}`)
      .send({ refreshToken: created.refreshToken }).expect(204);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: created.refreshToken }).expect(401);
  });

  it('cleans expired session history, action tokens and old rate-limit records', async () => {
    const created = await registerAndLogin(newEmail());
    await db.db.updateTable('auth.sessions').set({ idle_expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', created.user.id).execute();
    const key = randomUUID();
    await db.db.insertInto('auth.rate_limits').values({ key, window_start: new Date(Date.now() - 25 * 60 * 60_000), count: 1 }).execute();
    await db.db.insertInto('auth.action_tokens').values({ token_hash: key, user_id: created.user.id, purpose: 'reset', expires_at: new Date(Date.now() - 1000) }).execute();
    await app.get(AuthCleanup).cleanup();
    expect(await db.db.selectFrom('auth.sessions').select('id').where('user_id', '=', created.user.id).execute()).toHaveLength(0);
    expect(await db.db.selectFrom('auth.action_tokens').select('token_hash').where('token_hash', '=', key).execute()).toHaveLength(0);
    expect(await db.db.selectFrom('auth.rate_limits').select('key').where('key', '=', key).execute()).toHaveLength(0);
  });

  it('ignores spoofed forwarding and accepts client IP only with gateway attestation', async () => {
    const endpoint = () => request(app.getHttpServer()).post('/auth/resend-verification');
    for (let i = 0; i < 100; i++) {
      await endpoint().set('X-Forwarded-For', `192.0.2.${i}`)
        .set('X-Auth-Client-IP', `192.0.2.${i}`).set('X-Auth-Gateway-Secret', 'wrong')
        .send({ email: newEmail() }).expect(200);
    }
    await endpoint().set('X-Forwarded-For', '192.0.2.123').send({ email: newEmail() }).expect(429);
    await endpoint().set('X-Auth-Client-IP', '192.0.2.123')
      .set('X-Auth-Gateway-Secret', process.env.AUTH_GATEWAY_SECRET!).send({ email: newEmail() }).expect(200);
    // Logout is deliberately not throttled.
    await request(app.getHttpServer()).post('/auth/logout').send({ refreshToken: 'unknown' }).expect(204);
  });
});
