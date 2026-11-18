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
    const response = await f.post(`${f.schedule}/preview`, { format: 'single', playoffs: false, thirdPlace: false, availability }).expect(400);
    expect(response.body.message).toMatch(/Could not schedule (Alpha|Bravo|Charlie|Delta) vs (Alpha|Bravo|Charlie|Delta) in round \d+/);
    expect(response.body.message).toMatch(/1 of 6 games.*5 games remaining.*at most 1 game.*6 games.*No games were saved/);
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

  it.each([false, true])('schedules the whole playoff bracket and fills it from semifinal results (third place: %s)', async (thirdPlace) => {
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
    const bracket: { games: (PreviewGame & { homeName: string; awayName: string })[] } = (await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(201)).body;
    expect(bracket.games.map((game) => game.stage).sort()).toEqual(thirdPlace ? ['final', 'semifinal', 'semifinal', 'third_place'] : ['final', 'semifinal', 'semifinal']);
    const semis = bracket.games.filter((game) => game.stage === 'semifinal');
    expect(semis.map((game) => game.scheduledAt).sort()).toEqual(['2025-02-02T10:00:00.000Z', '2025-02-02T11:00:00.000Z']);
    const names = semis.map((game) => [rank.get(game.homeTeamId), rank.get(game.awayTeamId)].sort().join(':')).sort();
    expect(names).toEqual(['Alpha:Delta', 'Bravo:Charlie']);
    // Later rounds wait for both semifinals and name the results they take.
    for (const game of bracket.games.filter((item) => item.stage !== 'semifinal')) {
      expect(Date.parse(game.scheduledAt)).toBeGreaterThanOrEqual(Date.parse('2025-02-02T12:00:00.000Z'));
      expect(game.homeName).toMatch(game.stage === 'final' ? / winner$/ : / loser$/);
    }
    await f.post(f.playoffs, { availability: f.availability, games: semis }).expect(400);
    await f.post(f.playoffs, { availability: f.availability, games: bracket.games }).expect(201);
    await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(400);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.playoffStage).toBeNull();
    const waiting = (await f.games()).filter((game) => game.stage === 'final' || game.stage === 'third_place');
    expect(waiting).toHaveLength(thirdPlace ? 2 : 1);
    expect(waiting.every((game) => game.home_season_team_id === null && game.away_season_team_id === null)).toBe(true);
    await f.score(waiting[0].id, 30, 20).expect(400);
    const venueId = f.availability.venueIds[0];
    const early = await f.patch(`/games/${waiting[0].id}`, { scheduledAt: '2025-02-02T09:00:00Z', venueId, durationMinutes: 60 }).expect(400);
    expect(early.body.message).toMatch(/after the semifinal/);
    await f.patch(`/games/${waiting[0].id}`, { scheduledAt: '2025-02-02T15:00:00Z', venueId, durationMinutes: 60 }).expect(200);
    const alphaBravo = preliminaries.find((game) => [rank.get(game.home_season_team_id), rank.get(game.away_season_team_id)].sort().join(':') === 'Alpha:Bravo')!;
    const alphaHome = rank.get(alphaBravo.home_season_team_id) === 'Alpha';
    await f.score(alphaBravo.id, alphaHome ? 0 : 9999, alphaHome ? 9999 : 0).expect(400);
    await f.score(alphaBravo.id, alphaHome ? 11 : 0, alphaHome ? 0 : 11).expect(201);
    const semifinalGames = (await f.games()).filter((game) => game.stage === 'semifinal');
    expect(semifinalGames).toHaveLength(2);
    for (const game of semifinalGames) await f.score(game.id, 20, 10).expect(201);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(400);
    const filled = await f.games();
    const final = filled.find((game) => game.stage === 'final')!;
    expect(new Set([final.home_season_team_id, final.away_season_team_id])).toEqual(new Set(semifinalGames.map((game) => game.home_season_team_id)));
    if (thirdPlace) {
      const third = filled.find((game) => game.stage === 'third_place')!;
      expect(new Set([third.home_season_team_id, third.away_season_team_id])).toEqual(new Set(semifinalGames.map((game) => game.away_season_team_id)));
    }
    // A corrected semifinal moves the new winner into the waiting games until they are played.
    await f.score(semifinalGames[0].id, 10, 20).expect(201);
    const corrected = (await f.games()).find((game) => game.stage === 'final')!;
    expect([corrected.home_season_team_id, corrected.away_season_team_id]).toContain(semifinalGames[0].away_season_team_id);
    await f.score(semifinalGames[0].id, 21, 10).expect(201);
    await f.del(`/games/${semifinalGames[0].id}`).expect(400);
    const finalGames = (await f.games()).filter((game) => game.stage === 'final' || game.stage === 'third_place');
    const finalGame = finalGames.find((game) => game.stage === 'final')!;
    expect([finalGame.home_season_team_id, finalGame.away_season_team_id]).toContain(semifinalGames[0].home_season_team_id);
    await f.score(finalGame.id, 30, 20).expect(201);
    await f.score(semifinalGames[0].id, 10, 21).expect(400);
    if (thirdPlace) {
      await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(400);
      await f.score(finalGames.find((game) => game.stage === 'third_place')!.id, 30, 20).expect(201);
    }
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(201);
    await f.del(`/games/${finalGame.id}`).expect(400);
  });

  it('schedules the championship for semifinals that were saved on their own', async () => {
    const f = await fixture();
    const input = { format: 'single', playoffs: true, thirdPlace: true, availability: f.availability };
    const preview = (await f.post(`${f.schedule}/preview`, input).expect(201)).body;
    await f.post(f.schedule, { ...input, games: preview.games }).expect(201);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'active' }).expect(201);
    for (const game of await f.games()) await f.score(game.id, 10, 0).expect(201);
    const bracket = (await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(201)).body;
    await f.post(f.playoffs, { availability: f.availability, games: bracket.games }).expect(201);
    // Leave only the semifinals, as the earlier one-round flow did.
    for (const game of (await f.games()).filter((item) => item.stage === 'final' || item.stage === 'third_place')) await f.del(`/games/${game.id}`).expect(200);
    expect((await f.get(`${f.schedule}/status`).expect(200)).body.playoffStage).toBe('final');
    const semifinals = (await f.games()).filter((game) => game.stage === 'semifinal');
    const next: { games: (PreviewGame & { homeName: string })[] } = (await f.post(`${f.playoffs}/preview`, { availability: f.availability }).expect(201)).body;
    expect(next.games.map((game) => game.stage).sort()).toEqual(['final', 'third_place']);
    const semifinalEnd = Math.max(...semifinals.map((game) => Date.parse((game as StoredGame & { scheduled_at: string }).scheduled_at))) + 60 * 60000;
    for (const game of next.games) {
      expect(Date.parse(game.scheduledAt)).toBeGreaterThanOrEqual(semifinalEnd);
      expect(semifinals.map((semifinal) => semifinal.id + ':' + (game.stage === 'final' ? 'winner' : 'loser'))).toContain(game.homeTeamId);
    }
    await f.post(f.playoffs, { availability: f.availability, games: next.games }).expect(201);
    for (const game of semifinals) await f.score(game.id, 7, 9).expect(201);
    const final = (await f.games()).find((game) => game.stage === 'final')!;
    expect(new Set([final.home_season_team_id, final.away_season_team_id])).toEqual(new Set(semifinals.map((game) => game.away_season_team_id)));
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
