import { sql, type Kysely } from 'kysely'

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.seasons ADD CONSTRAINT seasons_valid_dates CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date), ADD CONSTRAINT seasons_valid_status CHECK (status IN ('draft', 'active', 'completed'))`.execute(db);
  await sql`CREATE UNIQUE INDEX season_teams_unique_registration ON league.season_teams(season_id, team_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX rosters_unique_jersey ON league.rosters(season_team_id, jersey_number) WHERE jersey_number IS NOT NULL`.execute(db);
  await sql`ALTER TABLE league.games ADD CONSTRAINT games_distinct_teams CHECK (home_season_team_id <> away_season_team_id), ADD CONSTRAINT games_valid_status CHECK (status IN ('scheduled', 'completed')), ADD CONSTRAINT games_valid_result CHECK ((status = 'scheduled' AND home_score IS NULL AND away_score IS NULL) OR (status = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score))`.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_valid_result, DROP CONSTRAINT games_valid_status, DROP CONSTRAINT games_distinct_teams`.execute(db);
  await sql`DROP INDEX league.rosters_unique_jersey`.execute(db);
  await sql`DROP INDEX league.season_teams_unique_registration`.execute(db);
  await sql`ALTER TABLE league.seasons DROP CONSTRAINT seasons_valid_status, DROP CONSTRAINT seasons_valid_dates`.execute(db);
}
