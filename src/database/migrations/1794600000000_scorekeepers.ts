import { sql, type Kysely } from 'kysely'

// Owners invite people by email to keep score for one league. Accepting adds a scorekeeper membership.
export async function up(db: Kysely<any>): Promise<void> {
  const duplicate = await sql`SELECT league_id FROM league.league_members GROUP BY league_id, user_id HAVING count(*) > 1 LIMIT 1`.execute(db)
  if (duplicate.rows.length) throw new Error('A user has more than one membership in the same league. Remove the duplicates first.')
  await sql`ALTER TABLE league.league_members
    ADD CONSTRAINT league_members_role_check CHECK (role IN ('scorekeeper')),
    ADD CONSTRAINT league_members_league_user_key UNIQUE (league_id, user_id)`.execute(db)
  await sql`CREATE TABLE league.invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    league_id uuid NOT NULL REFERENCES league.leagues(id),
    email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
    role text NOT NULL DEFAULT 'scorekeeper' CHECK (role IN ('scorekeeper')),
    token_hash text NOT NULL UNIQUE,
    invited_by_user_id uuid NOT NULL REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    revoked_at timestamptz
  )`.execute(db)
  await sql`CREATE INDEX invitations_league_id_idx ON league.invitations(league_id)`.execute(db)
  await sql`CREATE UNIQUE INDEX invitations_pending_email_key ON league.invitations(league_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE league.invitations`.execute(db)
  await sql`ALTER TABLE league.league_members DROP CONSTRAINT league_members_league_user_key, DROP CONSTRAINT league_members_role_check`.execute(db)
}

