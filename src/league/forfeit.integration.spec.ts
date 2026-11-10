import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

// This suite writes to PostgreSQL; opt in only with a disposable test database.
const databaseTests = process.env.AUTH_TEST_DB === '1' &&
  /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

type Team = { id: string; name: string };
type Game = {
  id: string; stage: string; status: string;
  home_season_team_id: string; away_season_team_id: string;
  home_score: number | null; away_score: number | null;
  forfeited_by_season_team_id: string | null;
};

databaseTests('game forfeits against disposable PostgreSQL', () => {
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
    // Other integration suites share this disposable database and IP address.
    await app.get(DatabaseService).db.deleteFrom('auth.rate_limits').execute();
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
    const org = (await post('/organizations', { name: 'Forfeit tests' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'League' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Season' }).expect(201)).body;
    const division = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      await post(`/leagues/${league.id}/teams`, { name, seasonId: season.id, divisionId: division.id }).expect(201);
    }
    const teams: Team[] = (await get(`/seasons/${season.id}/teams?divisionId=${division.id}`).expect(200)).body;
    const games = async (): Promise<Game[]> => (await get(`/seasons/${season.id}/games?divisionId=${division.id}`).expect(200)).body;
    const createGame = async () => (await post(`/seasons/${season.id}/games`, {
      homeTeamId: teams[0].id, awayTeamId: teams[1].id, scheduledAt: '2025-02-01T10:00:00Z',
    }).expect(201)).body as Game;
    const activate = () => post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    const forfeit = (id: string, forfeitingTeamId: string, auth = owner) => post(`/games/${id}/forfeit`, { forfeitingTeamId }, auth);
    const score = (id: string, homeScore: number, awayScore: number) => post(`/games/${id}/score`, { homeScore, awayScore });
    const stored = (id: string) => app.get(DatabaseService).db.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { post, get, org, league, season, division, teams, games, createGame, activate, forfeit, score, stored };
  }

  it.each(['home', 'away'] as const)('awards a 20–0 final and standings when the %s team forfeits', async (side) => {
    const f = await fixture();
    const game = await f.createGame();
    await f.activate();
    const loser = side === 'home' ? game.home_season_team_id : game.away_season_team_id;
    const winner = side === 'home' ? game.away_season_team_id : game.home_season_team_id;
    const expected = { status: 'completed', home_score: side === 'home' ? 0 : 20, away_score: side === 'home' ? 20 : 0, forfeited_by_season_team_id: loser };
    expect((await f.forfeit(game.id, loser).expect(201)).body).toMatchObject(expected);
    expect(await f.stored(game.id)).toMatchObject(expected);
    expect(await f.games()).toEqual(expect.arrayContaining([expect.objectContaining({ id: game.id, ...expected })]));
    const standings = (await f.get(`/seasons/${f.season.id}/standings?divisionId=${f.division.id}`).expect(200)).body;
    expect(standings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: winner, wins: 1, losses: 0, pointsFor: 20, pointsAgainst: 0, pointDifference: 20 }),
      expect.objectContaining({ id: loser, wins: 0, losses: 1, pointsFor: 0, pointsAgainst: 20, pointDifference: -20 }),
    ]));
  });

  it('rejects outsiders and invalid participants without changing the scheduled game', async () => {
    const f = await fixture();
    const other = await login();
    const game = await f.createGame();
    await f.activate();
    await f.forfeit(game.id, game.home_season_team_id, other).expect(404);
    await f.forfeit(game.id, f.teams[2].id).expect(400);
    await f.forfeit(game.id, 'not-a-uuid').expect(400);
    expect(await f.stored(game.id)).toMatchObject({ status: 'scheduled', home_score: null, away_score: null, forfeited_by_season_team_id: null });
  });

  it('rejects forfeits in draft and permits correction of a final forfeit after completion', async () => {
    const f = await fixture();
    const game = await f.createGame();
    await f.forfeit(game.id, game.home_season_team_id).expect(400);
    await f.activate();
    await f.forfeit(game.id, game.home_season_team_id).expect(201);
    await f.post(`/seasons/${f.season.id}/status`, { status: 'completed' }).expect(201);
    await f.forfeit(game.id, game.away_season_team_id).expect(201);
    expect(await f.stored(game.id)).toMatchObject({ status: 'completed', home_score: 20, away_score: 0, forfeited_by_season_team_id: game.away_season_team_id });
  });

  it('rejects a played final and preserves its score', async () => {
    const f = await fixture();
    const game = await f.createGame();
    await f.activate();
    await f.score(game.id, 85, 70).expect(201);
    await f.forfeit(game.id, game.home_season_team_id).expect(400);
    expect(await f.stored(game.id)).toMatchObject({ status: 'completed', home_score: 85, away_score: 70, forfeited_by_season_team_id: null });
  });

  it('rejects a scheduled game with player statistics', async () => {
    const f = await fixture();
    const game = await f.createGame();
    const player = (await f.post(`/organizations/${f.org.id}/players`, { firstName: 'Test', lastName: 'Player', dateOfBirth: '2000-01-01' }).expect(201)).body;
    const roster = (await f.post(`/season-teams/${game.home_season_team_id}/roster`, { playerId: player.id }).expect(201)).body;
    const db = app.get(DatabaseService).db;
    const stat = await db.insertInto('league.player_game_stats').values({ game_id: game.id, roster_id: roster.id, points: 2 }).returning('id').executeTakeFirstOrThrow();
    await f.activate();
    await f.forfeit(game.id, game.home_season_team_id).expect(400);
    expect(await f.stored(game.id)).toMatchObject({ status: 'scheduled', home_score: null, away_score: null, forfeited_by_season_team_id: null });
    expect(await db.selectFrom('league.player_game_stats').select('points').where('id', '=', stat.id).executeTakeFirstOrThrow()).toMatchObject({ points: 2 });
  });

  it('corrects the forfeiting team and converts a forfeit to a regular score', async () => {
    const f = await fixture();
    const game = await f.createGame();
    await f.activate();
    await f.forfeit(game.id, game.home_season_team_id).expect(201);
    expect((await f.forfeit(game.id, game.away_season_team_id).expect(201)).body).toMatchObject({
      status: 'completed', home_score: 20, away_score: 0, forfeited_by_season_team_id: game.away_season_team_id,
    });
    expect((await f.score(game.id, 75, 80).expect(201)).body).toMatchObject({
      status: 'completed', home_score: 75, away_score: 80, forfeited_by_season_team_id: null,
    });
    expect(await f.stored(game.id)).toMatchObject({ status: 'completed', home_score: 75, away_score: 80, forfeited_by_season_team_id: null });
    expect((await f.get(`/seasons/${f.season.id}/standings`).expect(200)).body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: game.away_season_team_id, wins: 1, losses: 0, pointsFor: 80, pointsAgainst: 75 }),
      expect.objectContaining({ id: game.home_season_team_id, wins: 0, losses: 1, pointsFor: 75, pointsAgainst: 80 }),
    ]));
  });

  it('uses forfeits in playoff seeding and protects existing downstream pairings', async () => {
    const f = await fixture();
    const venue = (await f.post(`/leagues/${f.league.id}/venues`, { name: 'Court' }).expect(201)).body;
    const availability = { startDate: '2025-02-01', endDate: '2025-02-02', windows: [
      { weekdays: [6], startTime: '08:00', endTime: '14:00' },
      { weekdays: [0], startTime: '10:00', endTime: '16:00' },
    ], timeZone: 'UTC', venueIds: [venue.id], durationMinutes: 60, restMinutes: 0 };
    const schedule = `/divisions/${f.division.id}/schedule`;
    const playoffs = `/divisions/${f.division.id}/playoffs`;
    const input = { format: 'single', playoffs: true, thirdPlace: false, availability };
    const preliminary = (await f.post(`${schedule}/preview`, input).expect(201)).body;
    await f.post(schedule, { ...input, games: preliminary.games }).expect(201);
    await f.activate();
    const names = new Map(f.teams.map((team) => [team.id, team.name]));
    const games = await f.games();
    const target = games.find((game) => [names.get(game.home_season_team_id), names.get(game.away_season_team_id)].sort().join(':') === 'Alpha:Bravo')!;
    const alpha = f.teams.find((team) => team.name === 'Alpha')!.id;
    const bravo = f.teams.find((team) => team.name === 'Bravo')!.id;
    for (const game of games) {
      if (game.id === target.id) await f.forfeit(game.id, bravo).expect(201);
      else {
        const homeWins = names.get(game.home_season_team_id)! < names.get(game.away_season_team_id)!;
        await f.score(game.id, homeWins ? 10 : 0, homeWins ? 0 : 10).expect(201);
      }
    }
    const semis = (await f.post(`${playoffs}/preview`, { availability }).expect(201)).body;
    expect(semis.games.map((game: { homeTeamId: string; awayTeamId: string }) => [names.get(game.homeTeamId), names.get(game.awayTeamId)].sort().join(':')).sort())
      .toEqual(['Alpha:Delta', 'Bravo:Charlie']);
    await f.post(playoffs, { availability, games: semis.games }).expect(201);
    await f.forfeit(target.id, alpha).expect(400);
    const alphaHome = target.home_season_team_id === alpha;
    await f.score(target.id, alphaHome ? 0 : 99, alphaHome ? 99 : 0).expect(400);
    expect(await f.stored(target.id)).toMatchObject({ forfeited_by_season_team_id: bravo, home_score: alphaHome ? 20 : 0, away_score: alphaHome ? 0 : 20 });

    const semifinalGames = (await f.games()).filter((game) => game.stage === 'semifinal');
    expect(semifinalGames).toHaveLength(2);
    const semifinal = semifinalGames[0];
    await f.forfeit(semifinal.id, semifinal.away_season_team_id).expect(201);
    await f.score(semifinalGames[1].id, 20, 10).expect(201);
    const final = (await f.post(`${playoffs}/preview`, { availability }).expect(201)).body;
    expect(new Set([final.games[0].homeTeamId, final.games[0].awayTeamId]))
      .toEqual(new Set(semifinalGames.map((game) => game.home_season_team_id)));
    await f.post(playoffs, { availability, games: final.games }).expect(201);
    await f.forfeit(semifinal.id, semifinal.home_season_team_id).expect(400);
    await f.score(semifinal.id, 10, 20).expect(400);
    expect(await f.stored(semifinal.id)).toMatchObject({ home_score: 20, away_score: 0, forfeited_by_season_team_id: semifinal.away_season_team_id });
    await f.score(semifinal.id, 21, 10).expect(201);
    expect(await f.stored(semifinal.id)).toMatchObject({ home_score: 21, away_score: 10, forfeited_by_season_team_id: null });
  });
});
