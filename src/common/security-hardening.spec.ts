import { databaseSsl } from '../database/database-ssl';
import { leagueBucket } from '../league/league-rate-limit.guard';

const limits = { read: 300, write: 60, schedule: 20, anonymous: 60 };
const env = (values: Record<string, string>) => ({ get: (key: string) => values[key] });

describe('league rate limit buckets', () => {
  it('gives schedule planning and saving the tightest budget', () => {
    for (const path of ['/league/seasons/s/schedule/preview', '/league/seasons/s/schedule/estimate', '/league/seasons/s/playoffs/suggest', '/league/seasons/s/schedule', '/league/divisions/d/playoffs', '/league/seasons/s/schedule/calendar']) {
      expect(leagueBucket('POST', path, true, limits)).toEqual(['schedule', 20]);
    }
  });
  it('separates reads, other writes and anonymous requests', () => {
    expect(leagueBucket('GET', '/league/seasons/s/schedule/status', true, limits)).toEqual(['read', 300]);
    expect(leagueBucket('PATCH', '/league/games/g', true, limits)).toEqual(['write', 60]);
    expect(leagueBucket('DELETE', '/league/teams/t', true, limits)).toEqual(['write', 60]);
    expect(leagueBucket('POST', '/league/seasons/s/schedule/preview', false, limits)).toEqual(['anonymous', 60]);
  });
});

describe('database TLS settings', () => {
  it('defaults to plain connections outside production', () => {
    expect(databaseSsl(env({}))).toBe(false);
  });
  it('requires TLS in production', () => {
    expect(() => databaseSsl(env({ NODE_ENV: 'production' }))).toThrow(/DB_SSL/);
    expect(() => databaseSsl(env({ NODE_ENV: 'production', DB_SSL: 'disable' }))).toThrow(/DB_SSL/);
    expect(() => databaseSsl(env({ DB_SSL: 'sometimes' }))).toThrow(/DB_SSL/);
  });
  it('encrypts with require and verifies certificates with verify-full', () => {
    expect(databaseSsl(env({ DB_SSL: 'require' }))).toEqual({ rejectUnauthorized: false });
    expect(databaseSsl(env({ NODE_ENV: 'production', DB_SSL: 'verify-full', DB_SSL_CA: 'line1\\nline2' }))).toEqual({ rejectUnauthorized: true, ca: 'line1\nline2' });
  });
});

