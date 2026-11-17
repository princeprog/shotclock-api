import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE auth.security_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    event text NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
    ip text CHECK (ip IS NULL OR length(ip) <= 64),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db)
  await sql`CREATE INDEX security_events_user_idx ON auth.security_events (user_id, created_at DESC)`.execute(db)
  await sql`CREATE INDEX security_events_created_idx ON auth.security_events (created_at)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE auth.security_events`.execute(db)
}

