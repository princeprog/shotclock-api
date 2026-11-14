import { BadRequestException } from '@nestjs/common';
import { LeagueService } from './league.service';
import type { DatabaseService } from '../database/database.service';

describe('division age eligibility', () => {
  const service = new LeagueService({} as DatabaseService);

  it('uses age at the season start and treats the limit as exclusive', () => {
    expect(() => service['eligible']('2009-09-02', '2026-09-01', null, 17)).not.toThrow();
    expect(() => service['eligible']('2009-09-01', '2026-09-01', null, 17)).toThrow(BadRequestException);
  });

  it('handles leap-day birthdays without shifting the calendar date', () => {
    expect(() => service['eligible']('2008-02-29', '2025-02-28', null, 17)).not.toThrow();
    expect(() => service['eligible']('2008-02-29', '2025-03-01', null, 17)).toThrow(BadRequestException);
  });

  it('requires a birth date for registration and a season start for age limits', () => {
    expect(() => service['eligible'](null, '2026-09-01', null, null)).toThrow(BadRequestException);
    expect(() => service['eligible']('2010-01-01', null, null, 18)).toThrow(BadRequestException);
    expect(() => service['eligible']('2010-01-01', null, null, null)).not.toThrow();
  });

  it('rejects a birth date after the season starts even in Open', () => {
    expect(() => service['eligible']('2026-09-02', '2026-09-01', null, null)).toThrow(BadRequestException);
  });

  it('rejects a birth date in the future', () => {
    expect(() => service['calendarDate']('2999-01-01')).toThrow(BadRequestException);
  });

  it('accepts a birth date that is today in a timezone ahead of UTC', () => {
    expect(() => service['calendarDate']('2026-11-09', Date.parse('2026-11-08T16:30:00Z'))).not.toThrow();
  });
});
