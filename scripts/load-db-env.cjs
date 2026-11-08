// Match the API's environment precedence: process environment, .env.local, .env.
for (const file of ['.env.local', '.env']) {
  try { process.loadEnvFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
if (DB_HOST && DB_PORT && DB_USER && DB_PASSWORD && DB_NAME) {
  const url = new URL('postgresql://localhost');
  url.hostname = DB_HOST.includes(':') && !DB_HOST.startsWith('[') ? `[${DB_HOST}]` : DB_HOST;
  url.port = DB_PORT;
  url.username = DB_USER;
  url.password = DB_PASSWORD;
  url.pathname = `/${DB_NAME}`;
  process.env.DATABASE_URL = url.toString();
} else {
  delete process.env.DATABASE_URL;
}
