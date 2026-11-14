import { sql, type Kysely } from 'kysely'

// The purpose check was created with the table before it moved to the auth schema, so find it by definition.
async function dropPurposeCheck(db: Kysely<any>) {
  await sql`DO $$ DECLARE name text; BEGIN
    SELECT conname INTO name FROM pg_constraint
      WHERE conrelid = 'auth.action_tokens'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%purpose%';
    IF name IS NOT NULL THEN EXECUTE format('ALTER TABLE auth.action_tokens DROP CONSTRAINT %I', name); END IF;
  END $$`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await dropPurposeCheck(db)
  await sql`ALTER TABLE auth.action_tokens ADD COLUMN new_email text,
    ADD CONSTRAINT action_tokens_purpose_check CHECK (purpose IN ('verify', 'reset', 'email_change')),
    ADD CONSTRAINT action_tokens_new_email_check CHECK ((purpose = 'email_change') = (new_email IS NOT NULL))`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM auth.action_tokens WHERE purpose = 'email_change'`.execute(db)
  await sql`ALTER TABLE auth.action_tokens DROP CONSTRAINT action_tokens_new_email_check`.execute(db)
  await dropPurposeCheck(db)
  await sql`ALTER TABLE auth.action_tokens DROP COLUMN new_email,
    ADD CONSTRAINT auth_action_tokens_purpose_check CHECK (purpose IN ('verify', 'reset'))`.execute(db)
}

