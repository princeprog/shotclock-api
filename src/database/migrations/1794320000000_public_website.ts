import { sql, type Kysely } from 'kysely'

const SLUG_CHECK = sql.raw("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60")

// Kept inline so this migration does not change if application slug rules evolve.
function slugify(name: string) {
  let base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '')
  if (base.length < 3) base = base ? `season-${base}` : 'season'
  return base
}

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.leagues ADD COLUMN published_at timestamptz,
    ADD COLUMN slug text CONSTRAINT leagues_slug_format CHECK (slug IS NULL OR (${SLUG_CHECK})),
    ADD CONSTRAINT leagues_slug_key UNIQUE (slug)`.execute(db)
  await sql`ALTER TABLE league.seasons ADD COLUMN slug text CONSTRAINT seasons_slug_format CHECK (slug IS NULL OR (${SLUG_CHECK}))`.execute(db)

  const seasons = await sql<{ id: string; league_id: string; name: string }>`SELECT id, league_id, name FROM league.seasons ORDER BY league_id, created_at, id`.execute(db)
  const taken = new Map<string, Set<string>>()
  for (const season of seasons.rows) {
    const used = taken.get(season.league_id) ?? new Set<string>()
    taken.set(season.league_id, used)
    const base = slugify(season.name)
    let slug = base
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
    used.add(slug)
    await sql`UPDATE league.seasons SET slug = ${slug} WHERE id = ${season.id}`.execute(db)
  }

  await sql`ALTER TABLE league.seasons ALTER COLUMN slug SET NOT NULL,
    ADD CONSTRAINT seasons_league_slug_key UNIQUE (league_id, slug)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.seasons DROP COLUMN slug`.execute(db)
  await sql`ALTER TABLE league.leagues DROP COLUMN slug, DROP COLUMN published_at`.execute(db)
}
