import { sql, type Kysely } from 'kysely'

// Live scoring: each league has a default game format, a game can be live, and every play is recorded as an event.
// The device that holds a game's live state is the only one allowed to record plays for it.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.leagues
    ADD COLUMN period_count smallint NOT NULL DEFAULT 4 CONSTRAINT leagues_period_count_check CHECK (period_count BETWEEN 1 AND 8),
    ADD COLUMN period_minutes smallint NOT NULL DEFAULT 10 CONSTRAINT leagues_period_minutes_check CHECK (period_minutes BETWEEN 1 AND 30),
    ADD COLUMN overtime_minutes smallint NOT NULL DEFAULT 5 CONSTRAINT leagues_overtime_minutes_check CHECK (overtime_minutes BETWEEN 1 AND 15),
    ADD COLUMN bonus_fouls smallint NOT NULL DEFAULT 5 CONSTRAINT leagues_bonus_fouls_check CHECK (bonus_fouls BETWEEN 1 AND 10)`.execute(db)
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_valid_status, DROP CONSTRAINT games_valid_result`.execute(db)
  await sql`ALTER TABLE league.games
    ADD CONSTRAINT games_valid_status CHECK (status IN ('scheduled', 'live', 'completed')),
    ADD CONSTRAINT games_valid_result CHECK ((status IN ('scheduled', 'live') AND home_score IS NULL AND away_score IS NULL)
      OR (status = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score))`.execute(db)
  await sql`CREATE TABLE league.game_live_states (
    game_id uuid PRIMARY KEY REFERENCES league.games(id),
    period smallint NOT NULL DEFAULT 1 CHECK (period BETWEEN 1 AND 20),
    period_count smallint NOT NULL CHECK (period_count BETWEEN 1 AND 8),
    period_minutes smallint NOT NULL CHECK (period_minutes BETWEEN 1 AND 30),
    overtime_minutes smallint NOT NULL CHECK (overtime_minutes BETWEEN 1 AND 15),
    bonus_fouls smallint NOT NULL CHECK (bonus_fouls BETWEEN 1 AND 10),
    clock_remaining_ms integer NOT NULL CHECK (clock_remaining_ms BETWEEN 0 AND 3600000),
    clock_running_since timestamptz,
    scorer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    scorer_device_id uuid,
    started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    finished_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db)
  await sql`CREATE TABLE league.game_events (
    id uuid PRIMARY KEY,
    game_id uuid NOT NULL REFERENCES league.games(id),
    sequence integer NOT NULL CHECK (sequence > 0),
    kind text NOT NULL CHECK (kind IN ('points', 'rebound', 'assist', 'steal', 'block', 'turnover', 'foul', 'timeout', 'period_end')),
    points smallint CHECK ((kind = 'points' AND points BETWEEN 1 AND 3) OR (kind <> 'points' AND points IS NULL)),
    season_team_id uuid REFERENCES league.season_teams(id),
    roster_id uuid REFERENCES league.rosters(id),
    period smallint NOT NULL CHECK (period BETWEEN 1 AND 20),
    clock_ms integer CHECK (clock_ms BETWEEN 0 AND 3600000),
    recorded_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    device_id uuid,
    client_recorded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at timestamptz,
    voided_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT game_events_sequence_key UNIQUE (game_id, sequence),
    CONSTRAINT game_events_side_check CHECK ((kind = 'period_end') = (season_team_id IS NULL)),
    CONSTRAINT game_events_player_check CHECK ((kind IN ('timeout', 'period_end')) = (roster_id IS NULL))
  )`.execute(db)
  await sql`CREATE INDEX game_events_roster_id_idx ON league.game_events(roster_id)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  const live = await sql`SELECT id FROM league.games WHERE status = 'live' LIMIT 1`.execute(db)
  if (live.rows.length) throw new Error('Some games are live. Finish them before rolling back.')
  await sql`DROP TABLE league.game_events`.execute(db)
  await sql`DROP TABLE league.game_live_states`.execute(db)
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_valid_result, DROP CONSTRAINT games_valid_status`.execute(db)
  await sql`ALTER TABLE league.games
    ADD CONSTRAINT games_valid_status CHECK (status IN ('scheduled', 'completed')),
    ADD CONSTRAINT games_valid_result CHECK ((status = 'scheduled' AND home_score IS NULL AND away_score IS NULL)
      OR (status = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score))`.execute(db)
  await sql`ALTER TABLE league.leagues DROP COLUMN bonus_fouls, DROP COLUMN overtime_minutes, DROP COLUMN period_minutes, DROP COLUMN period_count`.execute(db)
}

