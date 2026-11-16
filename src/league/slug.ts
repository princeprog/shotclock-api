// Web addresses for published leagues and seasons: lowercase letters, numbers and single hyphens, 3–60 characters.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 60;

export function isSlug(value: string) {
  return value.length >= SLUG_MIN && value.length <= SLUG_MAX && SLUG_PATTERN.test(value);
}

// Leaves room for a "-N" suffix when the base is already taken.
export function slugify(name: string, fallback: string) {
  let base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  if (base.length < SLUG_MIN) base = base ? `${fallback}-${base}` : fallback;
  return base;
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
