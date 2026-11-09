import { sql, type Kysely } from 'kysely'

// Migration types are frozen independently of generated database types.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM league.rosters r JOIN league.season_teams st ON st.id = r.season_team_id
      GROUP BY st.season_id, r.player_id HAVING count(*) > 1
    ) THEN RAISE EXCEPTION 'Cannot migrate: player records occur more than once in a season; resolve conflicting roster registrations first'; END IF;
  END $$`.execute(db)
  await sql`CREATE TABLE league.divisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), season_id uuid NOT NULL REFERENCES league.seasons(id),
    name text NOT NULL CHECK (length(trim(name)) > 0), max_age integer CHECK (max_age > 0 AND max_age <= 150),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, season_id)
  )`.execute(db)
  await sql`CREATE UNIQUE INDEX divisions_unique_name ON league.divisions(season_id, lower(trim(name)))`.execute(db)
  await sql`INSERT INTO league.divisions (season_id, name) SELECT id, 'Open' FROM league.seasons`.execute(db)
  await sql`ALTER TABLE league.season_teams ADD COLUMN division_id uuid`.execute(db)
  await sql`UPDATE league.season_teams st SET division_id = d.id FROM league.divisions d WHERE d.season_id = st.season_id`.execute(db)
  await sql`ALTER TABLE league.season_teams ALTER COLUMN division_id SET NOT NULL,
    ADD CONSTRAINT season_teams_division_fk FOREIGN KEY (division_id, season_id) REFERENCES league.divisions(id, season_id),
    ADD CONSTRAINT season_teams_id_season_division_key UNIQUE (id, season_id, division_id)`.execute(db)
  await sql`DROP INDEX league.season_teams_unique_registration`.execute(db)
  await sql`CREATE UNIQUE INDEX season_teams_unique_division_registration ON league.season_teams(season_id, division_id, team_id)`.execute(db)
  await sql`ALTER TABLE league.games ADD COLUMN division_id uuid`.execute(db)
  await sql`UPDATE league.games g SET division_id = st.division_id FROM league.season_teams st WHERE st.id = g.home_season_team_id`.execute(db)
  await sql`ALTER TABLE league.games ALTER COLUMN division_id SET NOT NULL,
    ADD CONSTRAINT games_home_division_fk FOREIGN KEY (home_season_team_id, season_id, division_id) REFERENCES league.season_teams(id, season_id, division_id),
    ADD CONSTRAINT games_away_division_fk FOREIGN KEY (away_season_team_id, season_id, division_id) REFERENCES league.season_teams(id, season_id, division_id)`.execute(db)
  await sql`ALTER TABLE league.rosters ADD COLUMN season_id uuid`.execute(db)
  await sql`UPDATE league.rosters r SET season_id = st.season_id FROM league.season_teams st WHERE st.id = r.season_team_id`.execute(db)
  await sql`ALTER TABLE league.rosters ALTER COLUMN season_id SET NOT NULL,
    ADD CONSTRAINT rosters_team_season_fk FOREIGN KEY (season_team_id, season_id) REFERENCES league.season_teams(id, season_id),
    ADD CONSTRAINT rosters_one_player_per_season UNIQUE (season_id, player_id)`.execute(db)
  await sql`ALTER TABLE league.players ADD COLUMN position text CHECK (position IS NULL OR position IN ('point_guard', 'shooting_guard', 'small_forward', 'power_forward', 'center'))`.execute(db)
  await sql`CREATE TABLE league.organization_players (
    organization_id uuid NOT NULL REFERENCES league.organizations(id), player_id uuid NOT NULL REFERENCES league.players(id),
    PRIMARY KEY (organization_id, player_id)
  )`.execute(db)
  await sql`INSERT INTO league.organization_players (organization_id, player_id)
    SELECT DISTINCT l.organization_id, r.player_id FROM league.rosters r
    JOIN league.season_teams st ON st.id = r.season_team_id JOIN league.leagues l ON l.id = st.league_id`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // Hold these locks until the migration transaction commits so the safety
  // check cannot race with a new division, registration, or player record.
  await sql`LOCK TABLE league.divisions, league.games, league.rosters, league.season_teams, league.organization_players, league.players IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM league.divisions WHERE name <> 'Open' OR max_age IS NOT NULL)
      OR EXISTS (SELECT 1 FROM league.players WHERE position IS NOT NULL)
      OR EXISTS (SELECT 1 FROM league.season_teams GROUP BY season_id, team_id HAVING count(*) > 1)
      OR EXISTS (SELECT 1 FROM league.organization_players op WHERE NOT EXISTS (
        SELECT 1 FROM league.rosters r JOIN league.season_teams st ON st.id = r.season_team_id
        JOIN league.leagues l ON l.id = st.league_id
        WHERE r.player_id = op.player_id AND l.organization_id = op.organization_id
      ))
    THEN RAISE EXCEPTION 'Cannot safely roll back divisions with division-specific data'; END IF;
  END $$`.execute(db)
  await sql`DROP TABLE league.organization_players`.execute(db)
  await sql`ALTER TABLE league.players DROP COLUMN position`.execute(db)
  await sql`ALTER TABLE league.rosters DROP CONSTRAINT rosters_one_player_per_season, DROP CONSTRAINT rosters_team_season_fk, DROP COLUMN season_id`.execute(db)
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_home_division_fk, DROP CONSTRAINT games_away_division_fk, DROP COLUMN division_id`.execute(db)
  await sql`DROP INDEX league.season_teams_unique_division_registration`.execute(db)
  await sql`CREATE UNIQUE INDEX season_teams_unique_registration ON league.season_teams(season_id, team_id)`.execute(db)
  await sql`ALTER TABLE league.season_teams DROP CONSTRAINT season_teams_id_season_division_key, DROP CONSTRAINT season_teams_division_fk, DROP COLUMN division_id`.execute(db)
  await sql`DROP TABLE league.divisions`.execute(db)
}
