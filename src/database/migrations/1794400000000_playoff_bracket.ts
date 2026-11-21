import { sql, type Kysely } from 'kysely'

// Playoff brackets: final and third-place games can be scheduled before their teams are known.
// A side without a team names the semifinal it comes from and whether it takes the winner or the loser.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.games
    ALTER COLUMN home_season_team_id DROP NOT NULL,
    ALTER COLUMN away_season_team_id DROP NOT NULL,
    ADD COLUMN home_source_game_id uuid REFERENCES league.games(id),
    ADD COLUMN home_source_outcome text,
    ADD COLUMN away_source_game_id uuid REFERENCES league.games(id),
    ADD COLUMN away_source_outcome text,
    ADD CONSTRAINT games_home_source_check CHECK ((home_source_game_id IS NULL) = (home_source_outcome IS NULL) AND (home_source_outcome IS NULL OR home_source_outcome IN ('winner', 'loser'))),
    ADD CONSTRAINT games_away_source_check CHECK ((away_source_game_id IS NULL) = (away_source_outcome IS NULL) AND (away_source_outcome IS NULL OR away_source_outcome IN ('winner', 'loser'))),
    ADD CONSTRAINT games_sides_known_check CHECK ((home_season_team_id IS NOT NULL OR home_source_game_id IS NOT NULL) AND (away_season_team_id IS NOT NULL OR away_source_game_id IS NOT NULL)),
    ADD CONSTRAINT games_source_stage_check CHECK ((home_source_game_id IS NULL AND away_source_game_id IS NULL) OR stage IN ('final', 'third_place')),
    ADD CONSTRAINT games_completed_teams_check CHECK (status = 'scheduled' OR (home_season_team_id IS NOT NULL AND away_season_team_id IS NOT NULL))`.execute(db)
  await sql`CREATE INDEX games_home_source_idx ON league.games (home_source_game_id) WHERE home_source_game_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX games_away_source_idx ON league.games (away_source_game_id) WHERE away_source_game_id IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  const open = await sql<{ id: string }>`SELECT id FROM league.games WHERE home_season_team_id IS NULL OR away_season_team_id IS NULL LIMIT 1`.execute(db)
  if (open.rows.length) throw new Error('Playoff games are waiting for semifinal results. Remove them before rolling back.')
  await sql`DROP INDEX league.games_home_source_idx`.execute(db)
  await sql`DROP INDEX league.games_away_source_idx`.execute(db)
  await sql`ALTER TABLE league.games
    DROP CONSTRAINT games_completed_teams_check, DROP CONSTRAINT games_source_stage_check, DROP CONSTRAINT games_sides_known_check,
    DROP CONSTRAINT games_away_source_check, DROP CONSTRAINT games_home_source_check,
    DROP COLUMN away_source_outcome, DROP COLUMN away_source_game_id, DROP COLUMN home_source_outcome, DROP COLUMN home_source_game_id,
    ALTER COLUMN home_season_team_id SET NOT NULL, ALTER COLUMN away_season_team_id SET NOT NULL`.execute(db)
}
