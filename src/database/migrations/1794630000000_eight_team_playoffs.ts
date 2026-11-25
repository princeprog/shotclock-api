import { sql, type Kysely } from 'kysely'

// Playoffs can take the top four or the top eight teams. An eight-team bracket starts with quarterfinals (seeds 1 to 8),
// whose winners fill the semifinals the same way semifinal winners fill the championship.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.division_schedules
    ADD COLUMN playoff_teams smallint NOT NULL DEFAULT 4 CONSTRAINT division_schedules_playoff_teams_check CHECK (playoff_teams IN (4, 8))`.execute(db)
  await sql`ALTER TABLE league.games
    DROP CONSTRAINT games_stage_check, DROP CONSTRAINT games_seed_range_check, DROP CONSTRAINT games_seed_stage_check, DROP CONSTRAINT games_source_stage_check`.execute(db)
  await sql`ALTER TABLE league.games
    ADD CONSTRAINT games_stage_check CHECK (stage IN ('preliminary', 'quarterfinal', 'semifinal', 'final', 'third_place')),
    ADD CONSTRAINT games_seed_range_check CHECK ((home_seed IS NULL OR home_seed BETWEEN 1 AND 8) AND (away_seed IS NULL OR away_seed BETWEEN 1 AND 8)),
    ADD CONSTRAINT games_seed_stage_check CHECK ((home_seed IS NULL AND away_seed IS NULL) OR stage IN ('quarterfinal', 'semifinal')),
    ADD CONSTRAINT games_source_stage_check CHECK ((home_source_game_id IS NULL AND away_source_game_id IS NULL) OR stage IN ('semifinal', 'final', 'third_place'))`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  const eight = await sql<{ id: string }>`SELECT id FROM league.games WHERE stage = 'quarterfinal' OR (stage = 'semifinal' AND (home_source_game_id IS NOT NULL OR away_source_game_id IS NOT NULL)) LIMIT 1`.execute(db)
  if (eight.rows.length) throw new Error('Some divisions have eight-team playoffs. Remove those brackets before rolling back.')
  await sql`ALTER TABLE league.games
    DROP CONSTRAINT games_source_stage_check, DROP CONSTRAINT games_seed_stage_check, DROP CONSTRAINT games_seed_range_check, DROP CONSTRAINT games_stage_check`.execute(db)
  await sql`ALTER TABLE league.games
    ADD CONSTRAINT games_stage_check CHECK (stage IN ('preliminary', 'semifinal', 'final', 'third_place')),
    ADD CONSTRAINT games_seed_range_check CHECK ((home_seed IS NULL OR home_seed BETWEEN 1 AND 4) AND (away_seed IS NULL OR away_seed BETWEEN 1 AND 4)),
    ADD CONSTRAINT games_seed_stage_check CHECK ((home_seed IS NULL AND away_seed IS NULL) OR stage = 'semifinal'),
    ADD CONSTRAINT games_source_stage_check CHECK ((home_source_game_id IS NULL AND away_source_game_id IS NULL) OR stage IN ('final', 'third_place'))`.execute(db)
  await sql`ALTER TABLE league.division_schedules DROP COLUMN playoff_teams`.execute(db)
}
