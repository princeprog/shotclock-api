import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.organizations ADD COLUMN archived_at timestamptz`.execute(db)
  await sql`ALTER TABLE league.leagues ADD COLUMN archived_at timestamptz,
    ADD COLUMN time_zone text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 100)`.execute(db)
  await sql`ALTER TABLE league.seasons ADD COLUMN archived_at timestamptz`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.seasons DROP COLUMN archived_at`.execute(db)
  await sql`ALTER TABLE league.leagues DROP COLUMN time_zone, DROP COLUMN archived_at`.execute(db)
  await sql`ALTER TABLE league.organizations DROP COLUMN archived_at`.execute(db)
}

