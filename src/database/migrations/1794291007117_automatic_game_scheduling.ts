import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE league.division_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    division_id uuid NOT NULL UNIQUE REFERENCES league.divisions(id),
    format text NOT NULL CHECK (format IN ('single', 'double')),
    playoffs boolean NOT NULL,
    third_place boolean NOT NULL,
    team_ids uuid[] NOT NULL CHECK (cardinality(team_ids) >= 2),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT division_schedules_third_place_check CHECK (playoffs OR NOT third_place),
    CONSTRAINT division_schedules_id_division_key UNIQUE (id, division_id)
  )`.execute(db)
  await sql`ALTER TABLE league.games
    ADD COLUMN stage text NOT NULL DEFAULT 'preliminary',
    ADD COLUMN round integer,
    ADD COLUMN duration_minutes integer,
    ADD COLUMN schedule_id uuid,
    ADD CONSTRAINT games_stage_check CHECK (stage IN ('preliminary', 'semifinal', 'final', 'third_place')),
    ADD CONSTRAINT games_round_check CHECK (round IS NULL OR round > 0),
    ADD CONSTRAINT games_duration_check CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
    ADD CONSTRAINT games_schedule_division_fk FOREIGN KEY (schedule_id, division_id) REFERENCES league.division_schedules(id, division_id),
    ADD CONSTRAINT games_playoff_schedule_check CHECK (stage = 'preliminary' OR schedule_id IS NOT NULL)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE league.games, league.division_schedules IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM league.games WHERE schedule_id IS NOT NULL OR stage <> 'preliminary' OR duration_minutes IS NOT NULL)
      OR EXISTS (SELECT 1 FROM league.division_schedules)
    THEN RAISE EXCEPTION 'Cannot remove scheduling metadata while generated schedules exist'; END IF;
  END $$`.execute(db)
  await sql`ALTER TABLE league.games DROP CONSTRAINT games_playoff_schedule_check, DROP CONSTRAINT games_schedule_division_fk,
    DROP CONSTRAINT games_duration_check, DROP CONSTRAINT games_round_check, DROP CONSTRAINT games_stage_check,
    DROP COLUMN schedule_id, DROP COLUMN duration_minutes, DROP COLUMN round, DROP COLUMN stage`.execute(db)
  await sql`DROP TABLE league.division_schedules`.execute(db)
}
