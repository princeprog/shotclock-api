import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

// This suite writes to PostgreSQL. Never enable it for any other database.
const databaseTests = process.env.AUTH_TEST_DB === '1' &&
  /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

type PreviewGame = {
  homeTeamId: string; awayTeamId: string; round: number; stage: string;
  scheduledAt: string; venueId: string; durationMinutes: number;
};
type StoredGame = {
  id: string; home_season_team_id: string; away_season_team_id: string;
  stage: string; status: string; home_score: number | null; away_score: number | null;
};

databaseTests('automatic scheduling against disposable PostgreSQL', () => {
  let app: INestApplication;
  const emails: { email: string; token: string }[] = [];

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); } })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  async function login() {
    const email = `${randomUUID()}@example.test`;
    const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((item) => item.email === email)!.token }).expect(200);
    const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    return `Bearer ${response.body.accessToken}`;
  }

  async function fixture() {
    const owner = await login();
    const post = (url: string, body: object = {}, auth = owner) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', auth).send(body);
    const get = (url: string, auth = owner) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth);
    const patch = (url: string, body: object, auth = owner) => request(app.getHttpServer()).patch(`/league${url}`).set('Authorization', auth).send(body);
    const del = (url: string, auth = owner) => request(app.getHttpServer()).delete(`/league${url}`).set('Authorization', auth);
    const org = (await post('/organizations', { name: 'Scheduling' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'League' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Season' }).expect(201)).body;
    const division = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    const venue = (await post(`/leagues/${league.id}/venues`, { name: 'Court' }).expect(201)).body;
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      await post(`/leagues/${league.id}/teams`, { name, seasonId: season.id, divisionId: division.id }).expect(201);
    }
    const teams: { id: string; name: string }[] = (await get(`/seasons/${season.id}/teams?divisionId=${division.id}`).expect(200)).body;
    const availability = { startDate: '2025-02-01', endDate: '2025-02-02',
      windows: [
        { weekdays: [6], startTime: '08:00', endTime: '14:00' },
        { weekdays: [0], startTime: '10:00', endTime: '16:00' },
      ], timeZone: 'UTC', venueIds: [venue.id], durationMinutes: 60, restMinutes: 0 };
    const schedule = `/divisions/${division.id}/schedule`;
    const playoffs = `/divisions/${division.id}/playoffs`;
    const games = async (): Promise<StoredGame[]> => (await get(`/seasons/${season.id}/games?divisionId=${division.id}`).expect(200)).body;
    const score = (id: string, homeScore: number, awayScore: number) => post(`/games/${id}/score`, { homeScore, awayScore });
    return { owner, post, get, patch, del, league, season, division, teams, availability, schedule, playoffs, games, score };
  }

  it('isolates schedule status, previews, saves and removal by owner', async () => {
    const f = await fixture();
    const other = await login();
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability: f.availability };
    const preview = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    await f.get(`${f.schedule}/status`, other).expect(404);
    await f.post(`${f.schedule}/preview`, input, other).expect(404);
    await f.post(f.schedule, { ...input, games: preview.games }, other).expect(404);
    await f.post(`${f.playoffs}/preview`, { availability: f.availability }, other).expect(404);
    await f.post(f.playoffs, { availability: f.availability, games: preview.games.slice(0, 2) }, other).expect(404);
    expect(await f.games()).toHaveLength(0);
    await f.post(f.schedule, { ...input, games: preview.games }).expect(201);
    const saved = await f.games();
    await f.del(`/games/${saved[0].id}`, other).expect(404);
    expect(await f.games()).toHaveLength(6);
  });

  it('previews and saves each single round robin pairing once and rejects concurrent duplicate saves atomically', async () => {
    const f = await fixture();
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability: f.availability };
    expect((await f.get(`${f.schedule}/status`).expect(200)).body).toMatchObject({ hasSchedule: false, canGeneratePreliminary: true });
    const preview: { games: PreviewGame[] } = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    expect(preview.games).toHaveLength(6);
    expect(await f.games()).toHaveLength(0);
    expect(new Set(preview.games.map((game) => [game.homeTeamId, game.awayTeamId].sort().join(':'))).size).toBe(6);
    expect(new Set(preview.games.flatMap((game) => [game.homeTeamId, game.awayTeamId]))).toEqual(new Set(f.teams.map((team) => team.id)));
    expect(preview.games.every((game) => game.stage === 'preliminary')).toBe(true);
    expect(preview.games.map((game) => game.round).sort()).toEqual([1, 1, 2, 2, 3, 3]);
    const attempts = await Promise.all([f.post(f.schedule, { ...input, games: preview.games }), f.post(f.schedule, { ...input, games: preview.games })]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(attempts.find((response) => response.status === 201)!.body).toEqual({ saved: 6 });
    const saved = await f.games();
    expect(saved).toHaveLength(6);
    expect(new Set(saved.map((game) => [game.home_season_team_id, game.away_season_team_id].sort().join(':'))).size).toBe(6);
    const schedules = await app.get(DatabaseService).db.selectFrom('league.division_schedules').select('id').where('division_id', '=', f.division.id).execute();
    expect(schedules).toHaveLength(1);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body).toMatchObject({ hasSchedule: true, canGeneratePreliminary: false });
  });

  it('rejects a conflicting edited preview without creating a schedule or any games', async () => {
    const f = await fixture();
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability: f.availability };
    const preview: { games: PreviewGame[] } = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    const edited = preview.games.map((game, index) => index === 1 ? { ...game, scheduledAt: preview.games[0].scheduledAt } : game);
    await f.post(f.schedule, { ...input, games: edited }).expect(400);
    expect(await f.games()).toHaveLength(0);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body).toMatchObject({ hasSchedule: false, canGeneratePreliminary: true });
    await f.post(f.schedule, { ...input, games: preview.games }).expect(201);
    expect(await f.games()).toHaveLength(6);
  });

  it('does not persist a partial schedule when playing windows have insufficient capacity', async () => {
    const f = await fixture();
    const availability = { ...f.availability, endDate: '2025-02-01', windows: [{ weekdays: [6], startTime: '08:00', endTime: '09:00' }] };
    await f.post(`${f.schedule}/preview`, { format: 'single', playoffs: false, thirdPlace: false, availability }).expect(400);
    expect(await f.games()).toHaveLength(0);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.hasSchedule).toBe(false);
  });

  it('rechecks a stale preview against an overlapping legacy game in another division', async () => {
    const f = await fixture();
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability: f.availability };
    const preview: { games: PreviewGame[] } = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    const other = (await f.post(`/seasons/${f.season.id}/divisions`, { name: 'Other division' }).expect(201)).body;
    for (const name of ['Echo', 'Foxtrot']) await f.post(`/leagues/${f.league.id}/teams`, { name, seasonId: f.season.id, divisionId: other.id }).expect(201);
    const teams: { id: string }[] = (await f.get(`/seasons/${f.season.id}/teams?divisionId=${other.id}`).expect(200)).body;
    await f.post(`/seasons/${f.season.id}/games`, { homeTeamId: teams[0].id, awayTeamId: teams[1].id,
      scheduledAt: preview.games[0].scheduledAt, venueId: f.availability.venueIds[0] }).expect(201);
    await f.post(f.schedule, { ...input, games: preview.games }).expect(400);
    expect(await f.games()).toHaveLength(0);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.hasSchedule).toBe(false);
  });

  it.each([false, true])('runs playoffs and requires the final and configured third-place game (third place: %s)', async (thirdPlace) => {
    const f = await fixture();
    const input = { format: 'single', playoffs: true, thirdPlace, availability: f.availability };
    const preview = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    await f.post(f.schedule, { ...input, games: preview.games }).expect(201);
    await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(400);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'active' }).expect(201);
    const rank = new Map(f.teams.map((team) => [team.id, team.name]));
    const preliminaries = await f.games();
    for (const game of preliminaries) {
      const homeWins = rank.get(game.home_season_team_id)! < rank.get(game.away_season_team_id)!;
      await f.score(game.id, homeWins ? 10 : 0, homeWins ? 0 : 10).expect(201);
    }
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(400);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.playoffStage).toBe('semifinal');
    const semis: { games: PreviewGame[] } = (await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(201)).body;
    expect(semis.games.map((game) => game.scheduledAt).sort()).toEqual(['2025-02-02T10:00:00.000Z', '2025-02-02T11:00:00.000Z']);
    const names = semis.games.map((game) => [rank.get(game.homeTeamId), rank.get(game.awayTeamId)].sort().join(':')).sort();
    expect(names).toEqual(['Alpha:Delta', 'Bravo:Charlie']);
    await f.post(f.playoffs, { availability: f.availability, games: semis.games }).expect(201);
    await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(400);
    const alphaBravo = preliminaries.find((game) => [rank.get(game.home_season_team_id), rank.get(game.away_season_team_id)].sort().join(':') === 'Alpha:Bravo')!;
    const alphaHome = rank.get(alphaBravo.home_season_team_id) === 'Alpha';
    await f.score(alphaBravo.id, alphaHome ? 0 : 9999, alphaHome ? 9999 : 0).expect(400);
    await f.score(alphaBravo.id, alphaHome ? 11 : 0, alphaHome ? 0 : 11).expect(201);
    const semifinalGames = (await f.games()).filter((game) => game.stage === 'semifinal');
    expect(semifinalGames).toHaveLength(2);
    for (const game of semifinalGames) await f.score(game.id, 20, 10).expect(201);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(400);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.playoffStage).toBe('final');
    const finals: { games: PreviewGame[] } = (await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(201)).body;
    expect(finals.games.map((game) => game.stage).sort()).toEqual(thirdPlace ? ['final', 'third_place'] : ['final']);
    const final = finals.games.find((game) => game.stage === 'final')!;
    expect(new Set([final.homeTeamId, final.awayTeamId])).toEqual(new Set(semifinalGames.map((game) => game.home_season_team_id)));
    if (thirdPlace) {
      const third = finals.games.find((game) => game.stage === 'third_place')!;
      expect(new Set([third.homeTeamId, third.awayTeamId])).toEqual(new Set(semifinalGames.map((game) => game.away_season_team_id)));
    }
    await f.post(f.playoffs, { availability: f.availability, games: finals.games }).expect(201);
    await f.score(semifinalGames[0].id, 10, 20).expect(400);
    await f.score(semifinalGames[0].id, 21, 10).expect(201);
    await f.del(`/games/${semifinalGames[0].id}`).expect(400);
    const finalGames = (await f.games()).filter((game) => game.stage === 'final' || game.stage === 'third_place');
    const finalGame = finalGames.find((game) => game.stage === 'final')!;
    await f.score(finalGame.id, 30, 20).expect(201);
    if (thirdPlace) {
      await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(400);
      await f.score(finalGames.find((game) => game.stage === 'third_place')!.id, 30, 20).expect(201);
    }
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(201);
    await f.del(`/games/${finalGame.id}`).expect(400);
  });

  it('protects generated participants and clears the schedule only after its last unplayed game is removed', async () => {
    const f = await fixture();
    const input = { format: 'single', playoffs: false, thirdPlace: false, availability: f.availability };
    const preview = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    await f.post(f.schedule, { ...input, games: preview.games }).expect(201);
    await f.post(`/leagues/${f.league.id}/teams`, { name: 'Late arrival', seasonId: f.season.id, divisionId: f.division.id }).expect(400);
    const games = await f.games();
    const first = games[0];
    const replacement = f.teams.find((team) => team.id !== first.home_season_team_id && team.id !== first.away_season_team_id)!;
    await f.patch(`/games/${first.id}`, { homeTeamId: first.home_season_team_id, awayTeamId: replacement.id,
      scheduledAt: '2025-02-02T20:00:00Z', venueId: f.availability.venueIds[0] }).expect(400);
    await f.del(`/games/${first.id}`).expect(200);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.hasSchedule).toBe(true);
    for (const game of games.slice(1)) await f.del(`/games/${game.id}`).expect(200);
    expect(await f.games()).toHaveLength(0);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body).toMatchObject({ hasSchedule: false, canGeneratePreliminary: true });
    await f.post(`/leagues/${f.league.id}/teams`, { name: 'Late arrival', seasonId: f.season.id, divisionId: f.division.id }).expect(201);
  });
});
