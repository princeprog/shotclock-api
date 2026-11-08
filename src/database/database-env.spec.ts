import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('database CLI configuration', () => {
  it('uses the same local override for migration settings and generated types', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shotclock-db-env-'));
    try {
      writeFileSync(join(directory, '.env'), 'DB_HOST=localhost\nDB_PORT=5432\nDB_USER=test\nDB_PASSWORD=test\nDB_NAME=base_db\nDATABASE_URL=postgresql://test:test@localhost:5432/base_db\n');
      writeFileSync(join(directory, '.env.local'), 'DB_NAME=local_db\n');
      const env = { ...process.env };
      for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DATABASE_URL']) delete env[key];
      const preload = join(process.cwd(), 'scripts', 'load-db-env.cjs');
      const output = execFileSync(process.execPath, ['--require', preload, '-e', 'console.log(JSON.stringify({name:process.env.DB_NAME,url:new URL(process.env.DATABASE_URL).pathname}))'], { cwd: directory, env, encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ name: 'local_db', url: '/local_db' });
      const overridden = execFileSync(process.execPath, ['--require', preload, '-e', 'console.log(JSON.stringify({name:process.env.DB_NAME,url:new URL(process.env.DATABASE_URL).pathname}))'], { cwd: directory, env: { ...env, DB_NAME: 'ci_db' }, encoding: 'utf8' });
      expect(JSON.parse(overridden)).toEqual({ name: 'ci_db', url: '/ci_db' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
