import { sql, type Kysely } from 'kysely'

// Semifinals can be scheduled with the round robin, before the standings decide who plays.
// A seed records which final standing a semifinal side takes: seeds 1 and 4 meet, and so do seeds 2 and 3.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.games
    ADD COLUMN home_seed smallint,
    ADD COLUMN away_seed smallint,
    ADD CONSTRAINT games_seed_range_check CHECK ((home_seed IS NULL OR home_seed BETWEEN 1 AND 4) AND (away_seed IS NULL OR away_seed BETWEEN 1 AND 4)),
    ADD CONSTRAINT games_seed_stage_check CHECK ((home_seed IS NULL AND away_seed IS NULL) OR stage = 'semifinal'),
    DROP CONSTRAINT games_sides_known_check`.execute(db)
  await sql`ALTER TABLE league.games ADD CONSTRAINT games_sides_known_check CHECK (
    (home_season_team_id IS NOT NULL OR home_source_game_id IS NOT NULL OR home_seed IS NOT NULL)
    AND (away_season_team_id IS NOT NULL OR away_source_game_id IS NOT NULL OR away_seed IS NOT NULL))`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  const waiting = await sql<{ id: string }>`SELECT id FROM league.games
    WHERE (home_season_team_id IS NULL AND home_seed IS NOT NULL) OR (away_season_team_id IS NULL AND away_seed IS NOT NULL) LIMIT 1`.execute(db)
  if (waiting.rows.length) throw new Error('Semifinals are waiting for final standings. Remove them before rolling back.')
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_sides_known_check, DROP CONSTRAINT games_seed_stage_check, DROP CONSTRAINT games_seed_range_check,
    DROP COLUMN away_seed, DROP COLUMN home_seed`.execute(db)
  await sql`ALTER TABLE league.games ADD CONSTRAINT games_sides_known_check CHECK (
    (home_season_team_id IS NOT NULL OR home_source_game_id IS NOT NULL) AND (away_season_team_id IS NOT NULL OR away_source_game_id IS NOT NULL))`.execute(db)
}

