import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.divisions ADD COLUMN min_age integer,
    ADD CONSTRAINT divisions_min_age_check CHECK (min_age IS NULL OR min_age BETWEEN 1 AND 150),
    ADD CONSTRAINT divisions_age_range_check CHECK (min_age IS NULL OR max_age IS NULL OR min_age < max_age)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE league.divisions IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM league.divisions WHERE min_age IS NOT NULL)
    THEN RAISE EXCEPTION 'Cannot remove minimum age while divisions use it'; END IF;
  END $$`.execute(db)
  await sql`ALTER TABLE league.divisions DROP CONSTRAINT divisions_age_range_check,
    DROP CONSTRAINT divisions_min_age_check, DROP COLUMN min_age`.execute(db)
}
