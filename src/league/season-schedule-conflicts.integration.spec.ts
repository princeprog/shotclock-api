import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;
type PreviewGame = { divisionId: string; homeTeamId: string; awayTeamId: string; stage: string; round: number; scheduledAt: string; venueId: string; durationMinutes: number };
const forSave = ({ divisionId, homeTeamId, awayTeamId, stage, round, scheduledAt, venueId, durationMinutes }: PreviewGame) => ({ divisionId, homeTeamId, awayTeamId, stage, round, scheduledAt, venueId, durationMinutes });

databaseTests('season schedule conflict handling against disposable PostgreSQL', () => {
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

  async function fixture() {
    await app.get(DatabaseService).db.deleteFrom('auth.rate_limits').execute();
    const email = `${randomUUID()}@example.test`; const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((item) => item.email === email)!.token }).expect(200);
    const owner = `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}`;
    const post = (url: string, body: object = {}) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', owner).send(body);
    const get = (url: string) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', owner);
    const org = (await post('/organizations', { name: 'Conflicts' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'League' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Season' }).expect(201)).body;
    const division = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    const venue = (await post(`/leagues/${league.id}/venues`, { name: 'Court' }).expect(201)).body;
    for (let i = 0; i < 4; i++) await post(`/leagues/${league.id}/teams`, { name: `Team ${i}`, seasonId: season.id, divisionId: division.id }).expect(201);
    const teams: { id: string; name: string }[] = (await get(`/seasons/${season.id}/teams?divisionId=${division.id}`).expect(200)).body;
    const availability = { startDate: '2026-11-10', endDate: '2026-11-10', windows: [{ weekdays: [2], startTime: '08:00', endTime: '10:00' }], timeZone: 'UTC', venueIds: [venue.id], durationMinutes: 60, restMinutes: 0 };
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability };
    return { post, get, league, season, division, venue, teams, availability, input, base: `/seasons/${season.id}/schedule` };
  }

  it('returns unplaced games with reasons and validates the partial draft without saving it', async () => {
    const f = await fixture();
    const preview = (await f.post(`${f.base}/preview`, f.input).expect(201)).body;
    expect(preview.games).toHaveLength(2);
    expect(preview.unplaced).toHaveLength(4);
    expect(preview.unplaced[0]).toEqual(expect.objectContaining({ divisionId: f.division.id, divisionName: f.division.name, homeName: expect.stringMatching(/^Team /), awayName: expect.stringMatching(/^Team /), round: 2, stage: 'preliminary', reason: expect.any(String) }));
    const body = { ...f.input, games: preview.games.map(forSave), divisionIds: [f.division.id] };
    expect((await f.post(`${f.base}/validate`, body).expect(201)).body.issues).toEqual([]);
    await f.post(`${f.base}/validate`, { ...body, games: [...body.games, body.games[0]] }).expect(400);
    await f.post(f.base, body).expect(400);
  });

  it('describes conflicts with the related draft and existing games', async () => {
    const f = await fixture();
    const other = (await f.post(`/seasons/${f.season.id}/divisions`, { name: 'Other' }).expect(201)).body;
    for (let i = 0; i < 2; i++) await f.post(`/leagues/${f.league.id}/teams`, { name: `Other ${i}`, seasonId: f.season.id, divisionId: other.id }).expect(201);
    const otherTeams: { id: string }[] = (await f.get(`/seasons/${f.season.id}/teams?divisionId=${other.id}`).expect(200)).body;
    const old = (await f.post(`/seasons/${f.season.id}/games`, { homeTeamId: otherTeams[0].id, awayTeamId: otherTeams[1].id, venueId: f.venue.id, scheduledAt: '2026-11-10T08:00:00Z', durationMinutes: 60 }).expect(201)).body;
    const preview = (await f.post(`${f.base}/preview`, f.input).expect(201)).body;
    expect(preview.games).toHaveLength(1);
    const moved = { ...forSave(preview.games[0]), scheduledAt: '2026-11-10T08:00:00.000Z' };
    const result = (await f.post(`${f.base}/validate`, { ...f.input, games: [moved], divisionIds: [f.division.id] }).expect(201)).body;
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0, type: 'venue', with: { kind: 'existing', id: old.id } })]));
    expect(result.existingGames).toEqual([expect.objectContaining({ id: old.id, homeName: 'Other 0', awayName: 'Other 1', divisionName: 'Other', venueName: 'Court', scheduledAt: '2026-11-10T08:00:00.000Z' })]);
  });

  it('explains the settings problem when no game fits', async () => {
    const f = await fixture();
    const response = await f.post(`${f.base}/preview`, { ...f.input, availability: { ...f.availability, blackoutDates: ['2026-11-10'] } }).expect(400);
    expect(response.body.message).toMatch(/blackout/i);
  });

  it('rejects team availability for teams outside the season', async () => {
    const f = await fixture();
    await f.post(`${f.base}/preview`, { ...f.input, availability: { ...f.availability, teamUnavailability: [{ teamId: randomUUID(), dates: ['2026-11-10'] }] } }).expect(400);
    const preview = (await f.post(`${f.base}/preview`, { ...f.input, availability: { ...f.availability, endDate: '2026-12-08', pace: 'weekly', maxGamesPerTeamPerDay: 1, changeoverMinutes: 0, teamUnavailability: [{ teamId: f.teams[0].id, dates: ['2026-11-10'] }] } }).expect(201)).body;
    expect(preview.unplaced).toEqual([]);
    expect(preview.games.filter((game: PreviewGame) => [game.homeTeamId, game.awayTeamId].includes(f.teams[0].id)).every((game: PreviewGame) => !game.scheduledAt.startsWith('2026-11-10'))).toBe(true);
  });
});

