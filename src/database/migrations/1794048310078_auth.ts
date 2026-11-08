import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE auth_users (
    id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
    name text, email_verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id)`.execute(db);
  await sql`CREATE TABLE auth_refresh_tokens (
    token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX auth_refresh_tokens_session_id_idx ON auth_refresh_tokens(session_id)`.execute(db);
  await sql`CREATE TABLE auth_action_tokens (
    token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
    expires_at timestamptz NOT NULL, used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX auth_action_tokens_user_purpose_idx ON auth_action_tokens(user_id, purpose)`.execute(db);
  await sql`CREATE TABLE auth_rate_limits (
    key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE auth_rate_limits`.execute(db);
  await sql`DROP TABLE auth_action_tokens`.execute(db);
  await sql`DROP TABLE auth_refresh_tokens`.execute(db);
  await sql`DROP TABLE auth_sessions`.execute(db);
  await sql`DROP TABLE auth_users`.execute(db);
}
