// Match the API's environment precedence: process environment, .env.local, .env.
for (const file of ['.env.local', '.env']) {
  try { process.loadEnvFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Codegen and migrations may connect as a separate owner role; the API itself uses DB_USER.
const { DB_HOST, DB_PORT, DB_NAME, DB_SSL } = process.env;
const DB_USER = process.env.DB_MIGRATION_USER || process.env.DB_USER;
const DB_PASSWORD = process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD;
if (DB_HOST && DB_PORT && DB_USER && DB_PASSWORD && DB_NAME) {
  const url = new URL('postgresql://localhost');
  url.hostname = DB_HOST.includes(':') && !DB_HOST.startsWith('[') ? `[${DB_HOST}]` : DB_HOST;
  url.port = DB_PORT;
  url.username = DB_USER;
  url.password = DB_PASSWORD;
  url.pathname = `/${DB_NAME}`;
  if (DB_SSL === 'require' || DB_SSL === 'verify-full') url.searchParams.set('sslmode', DB_SSL);
  process.env.DATABASE_URL = url.toString();
} else {
  delete process.env.DATABASE_URL;
}
