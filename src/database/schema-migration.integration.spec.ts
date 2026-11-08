import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import * as original from './migrations/1794048310078_auth';
import * as migration from './migrations/1794125555007_auth_league_schemas';

const databaseTests = process.env.SCHEMA_MIGRATION_TEST_DB === '1' && /^shotclock_auth_dev_test_[a-f0-9]+$/.test(process.env.DB_NAME ?? '') ? describe : describe.skip;

databaseTests('authentication and league schema migration', () => {
  let db: Kysely<any>;
  const userId = randomUUID();
  const sessionId = randomUUID();
  beforeAll(async () => {
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }) }) });
    await original.up(db);
    await sql`INSERT INTO public.auth_users (id,email,password_hash,email_verified) VALUES (${userId},'migration@example.test','preserved-hash',true)`.execute(db);
    await sql`INSERT INTO public.auth_sessions (id,user_id,idle_expires_at,absolute_expires_at) VALUES (${sessionId},${userId},now()+interval '1 day',now()+interval '2 days')`.execute(db);
    await sql`INSERT INTO public.auth_refresh_tokens (session_id,token_hash) VALUES (${sessionId},'preserved-token-hash')`.execute(db);
  });
  afterAll(async () => { await db?.destroy(); });

  it('preserves auth data through migration and rollback while enforcing the league relationships', async () => {
    await migration.up(db);
    const auth = await sql<{ password_hash: string; token_hash: string }>`SELECT u.password_hash, t.token_hash FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id JOIN auth.refresh_tokens t ON t.session_id=s.id WHERE u.id=${userId}`.execute(db);
    expect(auth.rows).toEqual([{ password_hash: 'preserved-hash', token_hash: 'preserved-token-hash' }]);
    const expectedTables = ['organizations','leagues','league_members','seasons','teams','season_teams','players','rosters','venues','games','player_game_stats'];
    const tables = await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema='league'`.execute(db);
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(expectedTables.sort());
    const organization = randomUUID(), league = randomUUID(), otherLeague = randomUUID(), season = randomUUID(), otherSeason = randomUUID(), team = randomUUID(), seasonTeam = randomUUID(), otherSeasonTeam = randomUUID(), player = randomUUID();
    await sql`INSERT INTO league.organizations (id,owner_user_id,name) VALUES (${organization},${userId},'Organization')`.execute(db);
    await sql`INSERT INTO league.leagues (id,organization_id,name) VALUES (${league},${organization},'League'),(${otherLeague},${organization},'Other league')`.execute(db);
    await sql`INSERT INTO league.seasons (id,league_id,name) VALUES (${season},${league},'Season')`.execute(db);
    await sql`INSERT INTO league.seasons (id,league_id,name) VALUES (${otherSeason},${league},'Other season')`.execute(db);
    await sql`INSERT INTO league.teams (id,league_id,name) VALUES (${team},${league},'Team')`.execute(db);
    await expect(sql`INSERT INTO league.season_teams (season_id,team_id,league_id) VALUES (${season},${team},${otherLeague})`.execute(db)).rejects.toMatchObject({ code: '23503' });
    await sql`INSERT INTO league.season_teams (id,season_id,team_id,league_id) VALUES (${seasonTeam},${season},${team},${league})`.execute(db);
    await sql`INSERT INTO league.season_teams (id,season_id,team_id,league_id) VALUES (${otherSeasonTeam},${otherSeason},${team},${league})`.execute(db);
    await sql`INSERT INTO league.players (id,user_id,first_name,last_name) VALUES (${player},${userId},'Test','Player')`.execute(db);
    await sql`INSERT INTO league.rosters (season_team_id,player_id) VALUES (${seasonTeam},${player})`.execute(db);
    await expect(sql`INSERT INTO league.rosters (season_team_id,player_id,jersey_number) VALUES (${seasonTeam},${player},-1)`.execute(db)).rejects.toMatchObject({ code: '23514' });
    const defaults = await sql<{ season: string; season_team: string; roster: string }>`SELECT s.status AS season, st.status AS season_team, r.status AS roster FROM league.seasons s JOIN league.season_teams st ON st.season_id=s.id JOIN league.rosters r ON r.season_team_id=st.id WHERE s.id=${season}`.execute(db);
    expect(defaults.rows[0]).toEqual({ season: 'draft', season_team: 'pending', roster: 'pending' });
    await expect(sql`INSERT INTO league.games (season_id,home_season_team_id,away_season_team_id) VALUES (${season},${seasonTeam},${otherSeasonTeam})`.execute(db)).rejects.toMatchObject({ code: '23503' });
    const game = await sql<{ status: string }>`INSERT INTO league.games (season_id,home_season_team_id,away_season_team_id) VALUES (${season},${seasonTeam},${seasonTeam}) RETURNING status`.execute(db);
    expect(game.rows[0].status).toBe('scheduled');
    await expect(sql`INSERT INTO league.games (season_id,home_season_team_id,away_season_team_id,home_score) VALUES (${season},${seasonTeam},${seasonTeam},-1)`.execute(db)).rejects.toMatchObject({ code: '23514' });
    await migration.down(db);
    const restored = await sql<{ password_hash: string; token_hash: string }>`SELECT u.password_hash,t.token_hash FROM public.auth_users u JOIN public.auth_sessions s ON s.user_id=u.id JOIN public.auth_refresh_tokens t ON t.session_id=s.id WHERE u.id=${userId}`.execute(db);
    expect(restored.rows).toEqual(auth.rows);
    await migration.up(db);
    const reapplied = await sql<{ id: string }>`SELECT id FROM auth.users WHERE id=${userId}`.execute(db);
    expect(reapplied.rows).toHaveLength(1);
  });
});
