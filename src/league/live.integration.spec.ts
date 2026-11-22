import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';
import { DatabaseService } from '../database/database.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('live scoring against isolated PostgreSQL', () => {
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

  it('scores a game play by play, hands it between devices, and finishes it into the result and player stats', async () => {
    const owner = await account();
    const post = (url: string, body: object, auth = owner.auth) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', auth).send(body);
    const get = (url: string, auth = owner.auth) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth);
    const db = app.get(DatabaseService).db;
    const org = (await post('/organizations', { name: 'Live org' }).expect(201)).body;
    const league = (await post(`/organizations/${org.id}/leagues`, { name: 'Live league' }).expect(201)).body;
    const season = (await post(`/leagues/${league.id}/seasons`, { name: 'Live season', startDate: '2026-01-01' }).expect(201)).body;
    const open = (await get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    for (const name of ['Hawks', 'Owls']) await post(`/leagues/${league.id}/teams`, { name, seasonId: season.id, divisionId: open.id }).expect(201);
    const [hawks, owls] = (await get(`/seasons/${season.id}/teams?divisionId=${open.id}`).expect(200)).body as { id: string }[];
    const roster: Record<string, string[]> = { [hawks.id]: [], [owls.id]: [] };
    for (const team of [hawks, owls]) for (let index = 0; index < 2; index += 1) {
      const player = (await post(`/organizations/${org.id}/players`, { firstName: 'Player', lastName: `${index}`, dateOfBirth: '2000-01-01' }).expect(201)).body;
      roster[team.id].push((await post(`/season-teams/${team.id}/roster`, { playerId: player.id, jerseyNumber: index + 4 }).expect(201)).body.id);
    }
    const game = await db.insertInto('league.games').values({ season_id: season.id, division_id: open.id, home_season_team_id: hawks.id, away_season_team_id: owls.id, stage: 'preliminary', status: 'scheduled', scheduled_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    const live = `/games/${game.id}/live`;
    const format = { periodCount: 2, periodMinutes: 10, overtimeMinutes: 5, bonusFouls: 2 };
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    await post(`${live}/start`, { deviceId: deviceA, ...format }).expect(400);
    await post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);

    const keeperEmail = `keeper-${randomUUID()}@example.test`;
    await post(`/leagues/${league.id}/invitations`, { email: keeperEmail }).expect(201);
    const keeper = await account(keeperEmail);
    const outsider = await account();
    await get(live, outsider.auth).expect(404);
    await post(`${live}/start`, { deviceId: deviceA, ...format }, keeper.auth).expect(404);
    await post('/invitations/accept', { token: invitations.find((item) => item.email === keeperEmail)!.token }, keeper.auth).expect(201);

    expect((await get(live, keeper.auth).expect(200)).body).toMatchObject({ status: 'scheduled', live: false, format: { periodCount: 4, periodMinutes: 10 } });
    const started = (await post(`${live}/start`, { deviceId: deviceA, ...format }, keeper.auth).expect(201)).body;
    expect(started).toMatchObject({ status: 'live', period: 1, clock: { remainingMs: 600000, running: false }, home: { score: 0, players: [expect.objectContaining({ jersey: 4 }), expect.objectContaining({ jersey: 5 })] } });
    await post(`${live}/start`, { deviceId: deviceB, ...format }, keeper.auth).expect(409);
    await post(`/games/${game.id}/score`, { homeScore: 1, awayScore: 0 }).expect(400);
    await request(app.getHttpServer()).patch(`/league/games/${game.id}`).set('Authorization', owner.auth).send({ scheduledAt: new Date().toISOString() }).expect(400);

    const play = (kind: string, team: string, player: string | undefined, extra: object = {}) => ({ id: randomUUID(), kind, seasonTeamId: team, rosterId: player, period: 1, clockMs: 500000, recordedAt: new Date().toISOString(), ...extra });
    const three = play('points', hawks.id, roster[hawks.id][0], { points: 3 });
    const batch = [three, play('assist', hawks.id, roster[hawks.id][1]), play('points', owls.id, roster[owls.id][0], { points: 2 }), play('foul', owls.id, roster[owls.id][1]), play('foul', owls.id, roster[owls.id][0]), play('timeout', hawks.id, undefined)];
    await post(`${live}/events`, { deviceId: deviceA, events: batch }, keeper.auth).expect(201);
    const repeated = (await post(`${live}/events`, { deviceId: deviceA, events: batch }, keeper.auth).expect(201)).body;
    expect(repeated).toMatchObject({ home: { score: 3, timeouts: 1, inBonus: true }, away: { score: 2, teamFouls: 2 } });
    expect(repeated.plays).toHaveLength(6);
    const listed = (await get(`/seasons/${season.id}/games?scope=season&status=scheduled`).expect(200)).body.items;
    expect(listed).toEqual([expect.objectContaining({ id: game.id, status: 'live', live_scored: true, live_home_score: 3, live_away_score: 2 })]);
    expect((await get(`/seasons/${season.id}/dashboard`).expect(200)).body.live).toEqual([expect.objectContaining({ id: game.id, live_home_score: 3, live_away_score: 2 })]);
    await post(`${live}/events`, { deviceId: deviceA, events: [play('points', hawks.id, roster[hawks.id][0])] }, keeper.auth).expect(400);
    await post(`${live}/events`, { deviceId: deviceA, events: [play('rebound', hawks.id, roster[owls.id][0])] }, keeper.auth).expect(400);
    await post(`${live}/events`, { deviceId: deviceA, events: [play('timeout', hawks.id, roster[hawks.id][0])] }, keeper.auth).expect(400);
    expect((await post(`${live}/events/${three.id}/void`, { deviceId: deviceA }, keeper.auth).expect(201)).body.home.score).toBe(0);

    await post(`${live}/events`, { deviceId: deviceB, events: [play('points', hawks.id, roster[hawks.id][0], { points: 2 })] }, keeper.auth).expect(409);
    await post(`${live}/claim`, { deviceId: deviceB }).expect(201);
    await post(`${live}/events`, { deviceId: deviceA, events: [play('points', hawks.id, roster[hawks.id][0], { points: 2 })] }, keeper.auth).expect(409);

    const clock = (running: boolean, remainingMs: number) => post(`${live}/clock`, { deviceId: deviceB, running, remainingMs, at: new Date().toISOString() });
    expect((await clock(true, 400000).expect(201)).body.clock.running).toBe(true);
    await post(`${live}/period`, { deviceId: deviceB }).expect(400);
    await clock(false, 0).expect(201);
    const second = (await post(`${live}/period`, { deviceId: deviceB }).expect(201)).body;
    expect(second).toMatchObject({ period: 2, clock: { remainingMs: 600000 }, away: { teamFouls: 0 } });
    await post(`${live}/events`, { deviceId: deviceB, events: [play('points', hawks.id, roster[hawks.id][1], { points: 2, period: 2 })] }).expect(201);
    await post(`${live}/finish`, { deviceId: deviceB }).expect(400);
    const overtime = (await post(`${live}/period`, { deviceId: deviceB }).expect(201)).body;
    expect(overtime).toMatchObject({ period: 3, clock: { remainingMs: 300000 } });
    await post(`${live}/events`, { deviceId: deviceB, events: [play('points', owls.id, roster[owls.id][1], { points: 1, period: 3 }), play('rebound', owls.id, roster[owls.id][1], { period: 3 })] }).expect(201);
    await post(`${live}/period`, { deviceId: deviceB }).expect(400);
    const finished = (await post(`${live}/finish`, { deviceId: deviceB }).expect(201)).body;
    expect(finished).toMatchObject({ status: 'completed', finalScore: { home: 2, away: 3 } });
    const stats = await db.selectFrom('league.player_game_stats').selectAll().where('game_id', '=', game.id).execute();
    expect(stats.find((row) => row.roster_id === roster[owls.id][1])).toMatchObject({ points: 1, rebounds: 1, fouls: 1 });
    expect(stats.find((row) => row.roster_id === roster[hawks.id][0])).toBeUndefined();
    expect((await get(`/seasons/${season.id}/standings`).expect(200)).body[0]).toMatchObject({ id: owls.id, wins: 1 });
    await post(`/games/${game.id}/forfeit`, { forfeitingTeamId: hawks.id }).expect(400);

    await post(`${live}/reopen`, {}, keeper.auth).expect(404);
    expect((await post(`${live}/reopen`, {}).expect(201)).body).toMatchObject({ status: 'live', period: 3, scorer: null });
    expect(await db.selectFrom('league.player_game_stats').select('id').where('game_id', '=', game.id).execute()).toEqual([]);
    await post(`${live}/events`, { deviceId: deviceB, events: [play('points', hawks.id, roster[hawks.id][0], { points: 2, period: 3 })] }).expect(409);
    await post(`${live}/claim`, { deviceId: deviceA }, keeper.auth).expect(201);
    await post(`${live}/events`, { deviceId: deviceA, events: [play('points', hawks.id, roster[hawks.id][0], { points: 3, period: 3 })] }, keeper.auth).expect(201);
    expect((await post(`${live}/finish`, { deviceId: deviceA }, keeper.auth).expect(201)).body.finalScore).toEqual({ home: 5, away: 3 });
    await post(`/seasons/${season.id}/status`, { status: 'draft' }).expect(400);
  });
});

