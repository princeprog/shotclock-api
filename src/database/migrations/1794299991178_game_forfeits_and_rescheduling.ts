import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.games
    ADD COLUMN forfeited_by_season_team_id uuid REFERENCES league.season_teams(id),
    ADD CONSTRAINT games_forfeit_result_check CHECK (
      forfeited_by_season_team_id IS NULL OR (
        status = 'completed' AND (
          (forfeited_by_season_team_id = home_season_team_id AND home_score = 0 AND away_score = 20)
          OR (forfeited_by_season_team_id = away_season_team_id AND home_score = 20 AND away_score = 0)
        )
      )
    )`.execute(db)
  await sql`CREATE TABLE league.game_schedule_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id uuid NOT NULL REFERENCES league.games(id) ON DELETE CASCADE,
    changed_by_user_id uuid NOT NULL REFERENCES auth.users(id),
    old_scheduled_at timestamptz,
    new_scheduled_at timestamptz NOT NULL,
    old_venue_id uuid REFERENCES league.venues(id),
    new_venue_id uuid REFERENCES league.venues(id),
    old_duration_minutes integer CHECK (old_duration_minutes BETWEEN 1 AND 1440),
    new_duration_minutes integer CHECK (new_duration_minutes BETWEEN 1 AND 1440),
    changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db)
  await sql`CREATE INDEX game_schedule_changes_game_id_idx ON league.game_schedule_changes (game_id, changed_at DESC, id DESC)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE league.games, league.game_schedule_changes IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM league.games WHERE forfeited_by_season_team_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM league.game_schedule_changes)
    THEN RAISE EXCEPTION 'Cannot remove forfeit or schedule history while records exist'; END IF;
  END $$`.execute(db)
  await sql`DROP TABLE league.game_schedule_changes`.execute(db)
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_forfeit_result_check, DROP COLUMN forfeited_by_season_team_id`.execute(db)
}
