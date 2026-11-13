import { estimateCourtCapacity, playingIntervals, scheduleMatches } from './schedule-algorithm';
import type { ScheduleAvailability } from './schedule-algorithm';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Reference: the original minute-by-minute scan, used to prove the per-day computation is equivalent.
function referenceIntervals(availability: ScheduleAvailability) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: availability.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const start = Date.parse(`${availability.startDate}T00:00:00Z`);
  const end = Date.parse(`${availability.endDate}T00:00:00Z`);
  const days = new Map<string, { start: number; end: number }[]>();
  for (let day = start; day <= end; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (availability.blackoutDates?.includes(date)) continue;
    const weekday = new Date(day).getUTCDay();
    const windows = availability.windows.filter((window) => window.weekdays.includes(weekday)).map((window) => ({
      start: Number(window.startTime.slice(0, 2)) * 60 + Number(window.startTime.slice(3)),
      end: Number(window.endTime.slice(0, 2)) * 60 + Number(window.endTime.slice(3)),
    }));
    if (windows.length) days.set(date, windows);
  }
  const intervals: { start: number; end: number }[] = [];
  let current: { start: number; end: number } | undefined;
  for (let at = start - DAY; at < end + 2 * DAY; at += MINUTE) {
    const parts = formatter.formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const local = Number(get('hour')) * 60 + Number(get('minute'));
    const inside = days.get(`${get('year')}-${get('month')}-${get('day')}`)?.some((window) => local >= window.start && local < window.end) ?? false;
    if (inside) {
      if (!current) { current = { start: at, end: at + MINUTE }; intervals.push(current); } else current.end = at + MINUTE;
    } else current = undefined;
  }
  return intervals;
}

const base: ScheduleAvailability = {
  startDate: '2026-11-01', endDate: '2026-11-08',
  windows: [{ weekdays: [0], startTime: '09:00', endTime: '13:00' }],
  timeZone: 'Asia/Manila', venueIds: ['court-a', 'court-b'], durationMinutes: 60, restMinutes: 0,
};

describe('playing windows', () => {
  it.each([
    ['America/New_York', '2026-03-05', '2026-03-12'],
    ['America/New_York', '2026-10-29', '2026-11-05'],
    ['Australia/Lord_Howe', '2026-04-02', '2026-04-08'],
    ['Australia/Lord_Howe', '2026-10-01', '2026-10-07'],
    ['Asia/Manila', '2026-01-01', '2026-01-31'],
  ])('matches a minute-by-minute scan in %s from %s', (timeZone, startDate, endDate) => {
    const availability: ScheduleAvailability = { ...base, timeZone, startDate, endDate, windows: [
      { weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' },
      { weekdays: [0, 6], startTime: '01:00', endTime: '03:30' },
      { weekdays: [0], startTime: '02:00', endTime: '04:00' },
      { weekdays: [3], startTime: '18:00', endTime: '22:00' },
    ] };
    expect(playingIntervals(availability)).toEqual(referenceIntervals(availability));
  });

  it('builds a full year of windows quickly', () => {
    const started = performance.now();
    playingIntervals({ ...base, startDate: '2027-01-01', endDate: '2027-12-31', windows: [{ weekdays: [0, 6], startTime: '08:00', endTime: '18:00' }] });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('blackout dates', () => {
  it('removes blackout dates from capacity and placement', () => {
    expect(estimateCourtCapacity(base, [])).toBe(16);
    expect(estimateCourtCapacity({ ...base, blackoutDates: ['2026-11-08'] }, [])).toBe(8);
    const games = scheduleMatches([{ homeTeamId: 'a', awayTeamId: 'b', round: 1, stage: 'preliminary' }], { ...base, blackoutDates: ['2026-11-01'] }, []);
    expect(games[0].scheduledAt).toBe('2026-11-08T01:00:00.000Z');
  });

  it('explains when every playing day is a blackout date', () => {
    expect(() => scheduleMatches([{ homeTeamId: 'a', awayTeamId: 'b', round: 1, stage: 'preliminary' }], { ...base, blackoutDates: ['2026-11-01', '2026-11-08'] }, []))
      .toThrow(/blackout/i);
  });

  it('rejects invalid or excessive blackout dates', () => {
    expect(() => estimateCourtCapacity({ ...base, blackoutDates: ['2026-02-30'] }, [])).toThrow(/blackout/i);
    expect(() => estimateCourtCapacity({ ...base, blackoutDates: ['2026-11-01', '2026-11-01'] }, [])).toThrow(/blackout/i);
    expect(() => estimateCourtCapacity({ ...base, blackoutDates: Array.from({ length: 367 }, () => '2026-11-01') }, [])).toThrow(/blackout/i);
  });
});

