import type { ConnectionOptions } from 'node:tls';

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

// TLS settings for PostgreSQL. verify-full checks the server certificate; require only encrypts.
export function databaseSsl(env: { get(key: string): string | undefined }): false | ConnectionOptions {
  const production = env.get('NODE_ENV') === 'production';
  const mode = env.get('DB_SSL') || (production ? '' : 'disable');
  if (!['disable', 'require', 'verify-full'].includes(mode)) throw new Error('DB_SSL must be disable, require or verify-full');
  if (production && mode === 'disable') throw new Error('DB_SSL must be require or verify-full in production');
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  const ca = env.get('DB_SSL_CA')?.replace(/\\n/g, '\n');
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

