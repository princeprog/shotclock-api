import { sql, type Kysely } from 'kysely';

// Isolated from existing live states so old games remain disabled.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE league.game_shot_clocks (
    game_id uuid PRIMARY KEY REFERENCES league.game_live_states(game_id) ON DELETE CASCADE,
    mode text NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'dual')),
    full_seconds smallint NOT NULL CHECK (full_seconds BETWEEN 1 AND 120),
    short_seconds smallint NOT NULL CHECK (short_seconds BETWEEN 1 AND 120),
    remaining_ms integer NOT NULL CHECK (remaining_ms BETWEEN 0 AND 120000),
    running_since timestamptz,
    visible boolean NOT NULL DEFAULT true,
    epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
    scorer_epoch integer NOT NULL DEFAULT 1 CHECK (scorer_epoch > 0),
    operator_device_id uuid,
    operator_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    scorer_lease_until timestamptz,
    operator_lease_until timestamptz,
    last_shot_at timestamptz,
    last_game_clock_at timestamptz
  )`.execute(db);
  await sql`CREATE TABLE league.game_shot_clock_history (
    id bigserial PRIMARY KEY,
    game_id uuid NOT NULL REFERENCES league.game_shot_clocks(game_id) ON DELETE CASCADE,
    period smallint NOT NULL,
    at timestamptz NOT NULL,
    remaining_ms integer NOT NULL,
    running_since timestamptz,
    visible boolean NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX game_shot_clock_history_lookup ON league.game_shot_clock_history (game_id, period, at DESC, id DESC)`.execute(db);
  await sql`CREATE TABLE league.game_shot_clock_commands (
    id uuid PRIMARY KEY,
    game_id uuid NOT NULL REFERENCES league.game_shot_clocks(game_id) ON DELETE CASCADE,
    epoch integer NOT NULL,
    device_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const enabled = await sql`SELECT 1 FROM league.game_shot_clocks LIMIT 1`.execute(db);
  if (enabled.rows.length) throw new Error('Shot-clock data exists; refusing to discard it');
  await sql`DROP TABLE league.game_shot_clock_commands`.execute(db);
  await sql`DROP TABLE league.game_shot_clock_history`.execute(db);
  await sql`DROP TABLE league.game_shot_clocks`.execute(db);
}
