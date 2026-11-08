# Shotclock API agent context

Shotclock is a basketball league management system for organizations. This repository is the NestJS API and PostgreSQL/Kysely database; the sibling `../shotclock/` contains the Next.js frontend. When available, start with `../docs/project-overview.md` and `../docs/progress.md`, then use `../docs/README.md` and `../docs/features/README.md` to select task-relevant context. Read `../shotclock/PROJECT_CONTEXT.md` as a fallback and this repository's `README.md` for API and database workflows. Verify current code before relying on documentation. If the sibling repository is unavailable, inspect current code rather than assuming frontend behavior.

When available, consult `../docs/agent-skills.md` and read relevant available skills on demand; follow the user's instructions and this repository's requirements.

- Use pnpm, Kysely migrations, and generated database types. Authentication tables live in `auth`; league-domain tables live in `league`. `auth.users` is the shared identity source.
- Never edit `src/database/db.d.ts` by hand or rewrite an applied migration. Create migrations with `pnpm migrate:create`, test against a disposable database, and run `pnpm generate:schema` after applying them. The schema-move rollback drops league data; do not run it on a database containing data to keep.
- Check the exact database target before migrations or code generation. CLI scripts use process environment, `.env.local`, then `.env`, and derive the codegen connection from `DB_*`. Never print credentials or tokens.
- For small changes, use changed-file lint and relevant tests instead of a full-project typecheck. Run a full typecheck only for shared types, API contracts, many files, or an explicit request; run it alone with `NODE_OPTIONS=--max-old-space-size=2048` and the local `node_modules/.bin/tsc`. Report only errors in touched files. After stopping a long-running check, confirm its Node process exited.
- Preserve existing uncommitted changes. Update the relevant workspace docs and standalone context snapshot when durable project facts change.
