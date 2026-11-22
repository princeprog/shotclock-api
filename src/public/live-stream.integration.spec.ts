import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

// Reads Server-Sent Events until one snapshot matches.
async function nextSnapshot(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }, match: (data: { home: { score: number } }) => boolean) {
  const decoder = new TextDecoder();
  for (;;) {
    const events = buffer.text.split('\n\n');
    buffer.text = events.pop() ?? '';
    for (const event of events) {
      const data = event.split('\n').find((line) => line.startsWith('data: '));
      if (event.includes('event: snapshot') && data) {
        const parsed = JSON.parse(data.slice(6));
        if (match(parsed)) return parsed;
      }
    }
    const { value, done } = await reader.read();
    if (done) throw new Error('Stream closed');
    buffer.text += decoder.decode(value, { stream: true });
  }
}

databaseTests('public live games against isolated PostgreSQL', () => {
  let app: INestApplication;
  let base = '';
  const emails: { email: string; token: string }[] = [];
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); }, notice: async () => {}, sendInvitation: async () => {} }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app?.close(); });

  it('shows a published game and streams its live score as plays are recorded', async () => {
    const email = `${randomUUID()}@example.test`;
    const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email)!.token }).expect(200);
    const auth = `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}`;
    const post = (url: string, body: object) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', auth).send(body);
    const get = (url: string) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth);
    const org = (await post('/organizations', { name: 'Public live' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'Public live league' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Public live season', startDate: '2026-01-01' }).expect(201)).body;
    const open = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    for (const name of ['Rays', 'Suns']) await post(`/leagues/${league.id}/teams`, { name, seasonId: season.id, divisionId: open.id }).expect(201);
    const [rays, suns] = (await get(`/seasons/${season.id}/teams?divisionId=${open.id}`).expect(200)).body as { id: string }[];
    const player = (await post(`/organizations/${org.id}/players`, { firstName: 'Lia', lastName: 'Santos', dateOfBirth: '2000-01-01' }).expect(201)).body;
    const roster = (await post(`/season-teams/${rays.id}/roster`, { playerId: player.id, jerseyNumber: 9 }).expect(201)).body;
    await post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    const game = await app.get(DatabaseService).db.insertInto('league.games').values({ season_id: season.id, division_id: open.id, home_season_team_id: rays.id, away_season_team_id: suns.id, stage: 'preliminary', status: 'scheduled', scheduled_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    const deviceId = randomUUID();
    await post(`/games/${game.id}/live/start`, { deviceId, periodCount: 4, periodMinutes: 10, overtimeMinutes: 5, bonusFouls: 5 }).expect(201);

    const slug = `public-live-${randomUUID().slice(0, 8)}`;
    await request(app.getHttpServer()).get(`/public/leagues/${slug}/seasons/${season.slug}/games/${game.id}`).expect(404);
    await request(app.getHttpServer()).patch(`/league/leagues/${league.id}/publication`).set('Authorization', auth).send({ published: true, slug }).expect(200);
    const detail = (await request(app.getHttpServer()).get(`/public/leagues/${slug}/seasons/${season.slug}/games/${game.id}`).expect(200)).body;
    expect(detail.game).toMatchObject({ status: 'live', scorer: null, home: { name: 'Rays', score: 0, players: [expect.objectContaining({ name: 'Lia Santos', jersey: 9 })] } });
    const listed = (await request(app.getHttpServer()).get(`/public/leagues/${slug}/seasons/${season.slug}/games?view=upcoming`).expect(200)).body.games;
    expect(listed).toEqual([expect.objectContaining({ id: game.id, status: 'live' })]);

    const abort = new AbortController();
    const response = await fetch(`${base}/public/games/${game.id}/live`, { signal: abort.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const buffer = { text: '' };
    expect((await nextSnapshot(reader, buffer, () => true)).home.score).toBe(0);
    await post(`/games/${game.id}/live/events`, { deviceId, events: [{ id: randomUUID(), kind: 'points', points: 3, seasonTeamId: rays.id, rosterId: roster.id, period: 1, clockMs: 500000, recordedAt: new Date().toISOString() }] }).expect(201);
    expect((await nextSnapshot(reader, buffer, (data) => data.home.score === 3)).home.score).toBe(3);
    abort.abort();
    expect((await request(app.getHttpServer()).get(`/public/leagues/${slug}/seasons/${season.slug}/games?view=upcoming`).expect(200)).body.games[0].home.score).toBe(3);
  });
});

