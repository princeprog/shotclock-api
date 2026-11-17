import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthMailer } from '../auth/auth-mailer.service';

const databaseTests = process.env.AUTH_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('public website API against isolated PostgreSQL', () => {
  let app: INestApplication;
  const emails: { email: string; token: string }[] = [];
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'integration-test-secret-with-at-least-32-bytes';
    process.env.PUBLIC_RATE_LIMIT_ANONYMOUS = '10000';
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer)
      .useValue({ send: async (email: string, _purpose: string, token: string) => { emails.push({ email, token }); } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  async function login() {
    const email = `${randomUUID()}@example.test`;
    const password = 'correct-horse-battery-123';
    await request(app.getHttpServer()).post('/auth/register').send({ email, password, name: 'Owner Person' }).expect(200);
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token: emails.find((e) => e.email === email)!.token }).expect(200);
    return { email, auth: `Bearer ${(await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body.accessToken}` };
  }
  const pub = (url: string) => request(app.getHttpServer()).get(`/public${url}`);

  it('shows only published leagues with active or completed seasons, without personal data', async () => {
    const owner = await login();
    const as = (auth: string) => ({
      post: (url: string, body: object) => request(app.getHttpServer()).post(`/league${url}`).set('Authorization', auth).send(body),
      patch: (url: string, body: object) => request(app.getHttpServer()).patch(`/league${url}`).set('Authorization', auth).send(body),
      get: (url: string) => request(app.getHttpServer()).get(`/league${url}`).set('Authorization', auth),
    });
    const api = as(owner.auth);
    const name = `Public Hoops ${randomUUID().slice(0, 8)}`;
    const org = (await api.post('/organizations', { name: 'Public org' }).expect(201)).body;
    const league = (await api.post(`/organizations/${org.id}/leagues`, { name, location: 'Quezon City', timeZone: 'Asia/Manila' }).expect(201)).body;
    const season = (await api.post(`/leagues/${league.id}/seasons`, { name: 'Summer 2026', startDate: '2026-06-01' }).expect(201)).body;
    expect(season.slug).toBe('summer-2026');
    expect((await api.post(`/leagues/${league.id}/seasons`, { name: 'Summer 2026!' }).expect(201)).body.slug).toBe('summer-2026-2');
    const open = (await api.get(`/seasons/${season.id}/divisions`).expect(200)).body[0];
    for (const team of ['Riverside Hawks', 'Eastside Kings']) await api.post(`/leagues/${league.id}/teams`, { name: team, seasonId: season.id, divisionId: open.id }).expect(201);
    const [kings, hawks] = (await api.get(`/seasons/${season.id}/teams?divisionId=${open.id}`).expect(200)).body;
    const player = (await api.post(`/organizations/${org.id}/players`, { firstName: 'Secret', lastName: 'Minor', dateOfBirth: '2012-02-03' }).expect(201)).body;
    await api.post(`/season-teams/${hawks.id}/roster`, { playerId: player.id }).expect(201);
    const played = (await api.post(`/seasons/${season.id}/games`, { homeTeamId: hawks.id, awayTeamId: kings.id, scheduledAt: '2026-06-06T10:00:00.000Z' }).expect(201)).body;
    await api.post(`/seasons/${season.id}/games`, { homeTeamId: kings.id, awayTeamId: hawks.id, scheduledAt: '2026-06-13T10:00:00.000Z' }).expect(201);

    // Unpublished leagues are hidden; a published league whose only season is a draft has no public seasons or directory entry.
    await pub('/leagues/not-a-league').expect(404);
    const published = (await api.patch(`/leagues/${league.id}/publication`, { published: true }).expect(200)).body;
    expect(published.slug).toMatch(/^public-hoops-/);
    expect(published.published_at).toBeTruthy();
    const slug = published.slug;
    expect((await pub(`/leagues/${slug}`).expect(200)).body).toMatchObject({ seasons: [], defaultSeason: null });
    expect((await pub(`/leagues?search=${encodeURIComponent(name)}`).expect(200)).body.total).toBe(0);
    await pub(`/leagues/${slug}/seasons/summer-2026`).expect(404);

    await api.post(`/seasons/${season.id}/status`, { status: 'active' }).expect(201);
    await api.post(`/games/${played.id}/score`, { homeScore: 81, awayScore: 66 }).expect(201);

    const detail = (await pub(`/leagues/${slug}`).expect(200)).body;
    expect(detail).toMatchObject({ league: { slug, name, location: 'Quezon City', timeZone: 'Asia/Manila', organization: 'Public org' }, defaultSeason: 'summer-2026' });
    expect(detail.seasons).toHaveLength(1);
    const directory = (await pub(`/leagues?search=${encodeURIComponent('Riverside')}`).expect(200)).body;
    expect(directory.items.map((item: { slug: string }) => item.slug)).toContain(slug);
    expect(directory.items.find((item: { slug: string }) => item.slug === slug)).toMatchObject({ teamCount: 2, divisionCount: 1, season: { slug: 'summer-2026', status: 'active' } });

    const base = `/leagues/${slug}/seasons/summer-2026`;
    expect((await pub(base).expect(200)).body).toMatchObject({ defaultDivision: open.id, divisions: [{ id: open.id, name: 'Open', teamCount: 2 }] });
    const standings = (await pub(`${base}/standings`).expect(200)).body;
    expect(standings.rows[0]).toMatchObject({ rank: 1, team: { id: hawks.id, name: 'Riverside Hawks' }, wins: 1, losses: 0, pointDifference: 15, streak: 'W1', lastFive: ['W'] });
    const stats = (await pub(`${base}/stats`).expect(200)).body;
    expect(stats.leaders.offense).toMatchObject({ team: { name: 'Riverside Hawks' }, value: 81 });
    const results = (await pub(`${base}/games?view=results`).expect(200)).body;
    expect(results.games).toHaveLength(1);
    expect(results.games[0]).toMatchObject({ status: 'completed', home: { name: 'Riverside Hawks', score: 81 }, away: { score: 66 }, forfeit: null });
    expect((await pub(`${base}/games?view=upcoming&team=${kings.id}`).expect(200)).body.games).toHaveLength(1);
    const team = (await pub(`${base}/teams/${hawks.id}`).expect(200)).body;
    expect(team).toMatchObject({ team: { name: 'Riverside Hawks' }, standing: { rank: 1 }, stats: { wins: 1 } });
    await pub(`${base}/teams/${randomUUID()}`).expect(404);
    await pub(`${base}/standings?division=${randomUUID()}`).expect(404);
    await pub(`/leagues/${slug}/seasons/summer-2026-2`).expect(404);

    const everything = JSON.stringify([detail, directory, standings, stats, results, team, (await pub(`${base}/teams`).expect(200)).body]);
    for (const secret of [owner.email, 'Owner Person', 'Secret', 'Minor', '2012-02-03', org.owner_user_id]) expect(everything).not.toContain(secret);

    // Only the owner can publish, web addresses are unique, and archiving hides the league.
    const other = as((await login()).auth);
    await other.patch(`/leagues/${league.id}/publication`, { published: false }).expect(404);
    const otherOrg = (await other.post('/organizations', { name: 'Other org' }).expect(201)).body;
    const otherLeague = (await other.post(`/organizations/${otherOrg.id}/leagues`, { name: 'Other' }).expect(201)).body;
    await other.patch(`/leagues/${otherLeague.id}/publication`, { published: true, slug }).expect(409);
    await other.patch(`/leagues/${otherLeague.id}/publication`, { published: true, slug: 'Bad Slug' }).expect(400);
    await api.post(`/leagues/${league.id}/archive`, {}).expect(201);
    await pub(`/leagues/${slug}`).expect(404);
    await api.patch(`/leagues/${league.id}/publication`, { published: false }).expect(409);
    await api.post(`/leagues/${league.id}/restore`, {}).expect(201);
    await api.patch(`/leagues/${league.id}/publication`, { published: false }).expect(200);
    await pub(`/leagues/${slug}`).expect(404);
  });
});
