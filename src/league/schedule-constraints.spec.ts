import { estimateCourtCapacity, planSchedule, playingIntervals, roundRobin, scheduleIssues, scheduleMatches, suggestSlots } from './schedule-algorithm';
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

const fixture = (homeTeamId: string, awayTeamId: string, round = 1) => ({ homeTeamId, awayTeamId, round, stage: 'preliminary' as const });
const draft = (homeTeamId: string, awayTeamId: string, scheduledAt: string, round = 1, venueId = 'court-a') =>
  ({ ...fixture(homeTeamId, awayTeamId, round), scheduledAt, venueId, durationMinutes: 60 });
const twoSundays: ScheduleAvailability = { ...base, venueIds: ['court-a', 'court-b'] };

describe('court changeover', () => {
  it('leaves the changeover gap between games on the same court', () => {
    const options = { ...base, venueIds: ['court-a'], endDate: '2026-11-01', windows: [{ weekdays: [0], startTime: '09:00', endTime: '12:00' }], changeoverMinutes: 15 };
    expect(estimateCourtCapacity(options, [])).toBe(2);
    const games = scheduleMatches([fixture('a', 'b'), fixture('c', 'd')], options, []);
    expect(games.map((game) => game.scheduledAt)).toEqual(['2026-11-01T01:00:00.000Z', '2026-11-01T02:15:00.000Z']);
    const issues = scheduleIssues([draft('a', 'b', '2026-11-01T01:00:00Z'), draft('c', 'd', '2026-11-01T02:05:00Z')], options, []);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/changeover/i);
  });
});

describe('team limits', () => {
  it('allows one game per team per day and moves the next game to another day', () => {
    const options = { ...twoSundays, maxGamesPerTeamPerDay: 1 };
    const games = scheduleMatches([fixture('a', 'b', 1), fixture('a', 'c', 2)], options, []);
    expect(games.map((game) => game.scheduledAt.slice(0, 10))).toEqual(['2026-11-01', '2026-11-08']);
    expect(() => scheduleMatches([fixture('a', 'b', 1), fixture('a', 'c', 2)], { ...options, endDate: '2026-11-01' }, []))
      .toThrow(/games-per-day limit/i);
    const issues = scheduleIssues([draft('a', 'b', '2026-11-01T01:00:00Z'), draft('a', 'c', '2026-11-01T03:00:00Z', 2)], options, []);
    expect(issues.filter((issue) => /daily limit/i.test(issue.message)).map((issue) => issue.index)).toEqual([0, 1]);
  });

  it('counts existing games toward the daily limit', () => {
    const existing = [{ homeTeamId: 'a', awayTeamId: 'x', scheduledAt: '2026-11-01T04:00:00Z', venueId: 'court-b', durationMinutes: 60 }];
    const games = scheduleMatches([fixture('a', 'b')], { ...twoSundays, maxGamesPerTeamPerDay: 1 }, existing);
    expect(games[0].scheduledAt.slice(0, 10)).toBe('2026-11-08');
  });

  it('plays one game per team each week with weekly pacing', () => {
    const options = { ...twoSundays, pace: 'weekly' as const, windows: [{ weekdays: [0, 6], startTime: '09:00', endTime: '13:00' }] };
    const games = scheduleMatches([fixture('a', 'b', 1), fixture('c', 'd', 1), fixture('a', 'c', 2), fixture('b', 'd', 2)], options, []);
    // Weeks are 7-day blocks from the start date (Sunday), so Saturday the 7th is still the first week.
    expect(games.map((game) => game.scheduledAt.slice(0, 10))).toEqual(['2026-11-01', '2026-11-01', '2026-11-08', '2026-11-08']);
    const issues = scheduleIssues([draft('a', 'b', '2026-11-01T01:00:00Z'), draft('a', 'c', '2026-11-08T01:00:00Z', 2)], options, []);
    expect(issues.filter((issue) => /weekly pacing/i.test(issue.message)).map((issue) => issue.index)).toEqual([]);
    const sameWeek = scheduleIssues([draft('a', 'b', '2026-11-01T01:00:00Z'), draft('a', 'c', '2026-11-06T23:00:00Z', 2)], { ...options, windows: [{ weekdays: [0, 6], startTime: '07:00', endTime: '13:00' }] }, []);
    expect(sameWeek.filter((issue) => /weekly pacing/i.test(issue.message)).map((issue) => issue.index)).toEqual([0, 1]);
  });

  it('keeps a team 7 days apart under weekly pacing, even across a week boundary', () => {
    // The range starts on a Sunday, so a Saturday and the next Sunday fall in different 7-day blocks but are only a day apart.
    const options = { ...twoSundays, pace: 'weekly' as const, endDate: '2026-11-15', windows: [{ weekdays: [0, 6], startTime: '09:00', endTime: '10:00' }], venueIds: ['court-a'] };
    const games = scheduleMatches([fixture('c', 'd', 1), fixture('e', 'f', 1), fixture('a', 'b', 1), fixture('a', 'c', 2)], options, []);
    const aDays = games.filter((game) => game.homeTeamId === 'a' || game.awayTeamId === 'a').map((game) => Date.parse(game.scheduledAt.slice(0, 10)) / 86_400_000);
    expect(aDays[1] - aDays[0]).toBeGreaterThanOrEqual(7);
    const backToBack = scheduleIssues([draft('a', 'b', '2026-11-07T01:00:00Z'), draft('a', 'c', '2026-11-08T01:00:00Z', 2)], options, []);
    expect(backToBack.filter((issue) => issue.type === 'weekly_limit').map((issue) => issue.index)).toEqual([0, 1]);
  });

  it('keeps games off team unavailable dates and reports them', () => {
    const options = { ...twoSundays, teamUnavailability: [{ teamId: 'a', dates: ['2026-11-01'] }] };
    const games = scheduleMatches([fixture('a', 'b'), fixture('c', 'd')], options, []);
    expect(games.map((game) => game.scheduledAt.slice(0, 10))).toEqual(['2026-11-08', '2026-11-01']);
    const issues = scheduleIssues([draft('a', 'b', '2026-11-01T01:00:00Z')], options, []);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/unavailable on this date/i);
  });

  it('reports games on blackout dates', () => {
    const issues = scheduleIssues([draft('a', 'b', '2026-11-08T01:00:00Z')], { ...twoSundays, blackoutDates: ['2026-11-08'] }, []);
    expect(issues.map((issue) => issue.message)).toEqual([expect.stringMatching(/blackout date/i)]);
  });
});

describe('spread pacing', () => {
  const sixSundays: ScheduleAvailability = { ...base, endDate: '2026-12-06', pace: 'spread' };

  it('spaces each division round evenly across the playing days', () => {
    const games = scheduleMatches(roundRobin(['a', 'b', 'c', 'd'], 'single').map((match) => ({ ...match, groupId: 'x' })), sixSundays, []);
    const firstDay = (round: number) => games.filter((game) => game.round === round).map((game) => game.scheduledAt.slice(0, 10)).sort()[0];
    expect([firstDay(1), firstDay(2), firstDay(3)]).toEqual(['2026-11-01', '2026-11-15', '2026-11-29']);
    expect(games.every((game) => !('groupId' in game))).toBe(true);
  });

  it('spaces each division by its own number of rounds', () => {
    const matches = [
      ...roundRobin(['a', 'b', 'c', 'd'], 'single').map((match) => ({ ...match, groupId: 'x' })),
      ...roundRobin(['e', 'f'], 'double').map((match) => ({ ...match, groupId: 'y' })),
    ];
    const games = scheduleMatches(matches, sixSundays, []);
    expect(games.filter((game) => game.homeTeamId === 'e' || game.awayTeamId === 'e').map((game) => game.scheduledAt.slice(0, 10))).toEqual(['2026-11-01', '2026-11-22']);
  });
});

describe('fair tip-off times', () => {
  const saturdays: ScheduleAvailability = { ...base, venueIds: ['court-a'], startDate: '2026-11-07', endDate: '2026-12-19', windows: [{ weekdays: [6], startTime: '09:00', endTime: '11:00' }] };
  const earlyGames = (games: { homeTeamId: string; awayTeamId: string; scheduledAt: string }[]) => {
    const counts: Record<string, number> = {};
    for (const game of games) if (game.scheduledAt.endsWith('T01:00:00.000Z')) for (const team of [game.homeTeamId, game.awayTeamId]) counts[team] = (counts[team] ?? 0) + 1;
    return ['a', 'b', 'c', 'd'].map((team) => counts[team] ?? 0);
  };

  it('balances early and late tip-offs across teams', () => {
    const matches = roundRobin(['a', 'b', 'c', 'd'], 'double');
    const compact = earlyGames(scheduleMatches(matches, { ...saturdays, pace: 'compact' }, []));
    const balanced = earlyGames(scheduleMatches(matches, { ...saturdays, pace: 'weekly' }, []));
    expect(Math.max(...compact) - Math.min(...compact)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...balanced) - Math.min(...balanced)).toBeLessThanOrEqual(2);
  });

  it('falls back to earliest slots when balancing would leave a game unplaced', () => {
    const options: ScheduleAvailability = { ...base, venueIds: ['court-a'], pace: 'spread', windows: [{ weekdays: [0], startTime: '09:00', endTime: '11:00' }] };
    const existing = [{ homeTeamId: 'c', awayTeamId: 'x', scheduledAt: '2026-11-08T01:00:00Z', venueId: null, durationMinutes: 60 }];
    const games = scheduleMatches([fixture('a', 'e', 1), fixture('f', 'g', 1), fixture('a', 'b', 2), fixture('c', 'd', 2)], options, existing);
    expect(games.map((game) => game.scheduledAt)).toEqual(['2026-11-01T01:00:00.000Z', '2026-11-01T02:00:00.000Z', '2026-11-08T01:00:00.000Z', '2026-11-08T02:00:00.000Z']);
  });
});

describe('per-team round order', () => {
  it('lets other teams play a later round while one team waits', () => {
    const options = { ...twoSundays, endDate: '2026-11-01', restMinutes: 0 };
    const existing = [{ homeTeamId: 'b', awayTeamId: 'x', scheduledAt: '2026-11-01T01:00:00Z', venueId: null, durationMinutes: 60 }];
    const games = scheduleMatches([fixture('a', 'b', 1), fixture('c', 'd', 2)], options, existing);
    expect(games.map((game) => game.scheduledAt)).toEqual(['2026-11-01T02:00:00.000Z', '2026-11-01T01:00:00.000Z']);
  });
});

describe('constraint settings validation', () => {
  it('rejects invalid pacing, limits and team availability', () => {
    expect(() => estimateCourtCapacity({ ...base, pace: 'fast' as never }, [])).toThrow(/pace/i);
    expect(() => estimateCourtCapacity({ ...base, maxGamesPerTeamPerDay: 0 }, [])).toThrow(/maxGamesPerTeamPerDay/);
    expect(() => estimateCourtCapacity({ ...base, maxGamesPerTeamPerDay: 11 }, [])).toThrow(/maxGamesPerTeamPerDay/);
    expect(() => estimateCourtCapacity({ ...base, changeoverMinutes: 241 }, [])).toThrow(/changeoverMinutes/);
    expect(() => estimateCourtCapacity({ ...base, teamUnavailability: [{ teamId: 'a', dates: [] }, { teamId: 'a', dates: [] }] }, [])).toThrow(/teamUnavailability/);
    expect(() => estimateCourtCapacity({ ...base, teamUnavailability: [{ teamId: 'a', dates: ['2026-13-01'] }] }, [])).toThrow(/teamUnavailability/);
  });
});

describe('partial placement', () => {
  it('places what fits and explains each unplaced game', () => {
    const options = { ...base, venueIds: ['court-a'], endDate: '2026-11-01', windows: [{ weekdays: [0], startTime: '09:00', endTime: '11:00' }] };
    const plan = planSchedule([fixture('a', 'b'), fixture('c', 'd'), fixture('e', 'f'), fixture('g', 'h')], options, []);
    expect(plan.games.map(({ index, game }) => [index, game.scheduledAt])).toEqual([[0, '2026-11-01T01:00:00.000Z'], [1, '2026-11-01T02:00:00.000Z']]);
    expect(plan.unplaced.map(({ index, reason }) => [index, reason])).toEqual([[2, expect.stringMatching(/at most 2 games/i)], [3, expect.stringMatching(/at most 2 games/i)]]);
    expect(() => scheduleMatches([fixture('a', 'b'), fixture('c', 'd'), fixture('e', 'f')], options, [])).toThrow(/2 of 3 games placed/i);
  });

  it('places the remaining games around pinned games', () => {
    const options = { ...base, endDate: '2026-11-01', restMinutes: 0, venueIds: ['court-a'] };
    const pinned = [draft('a', 'b', '2026-11-01T02:00:00Z', 1)];
    const plan = planSchedule([fixture('c', 'd', 1), fixture('a', 'c', 2)], options, [], pinned);
    expect(plan.games.map(({ index, game }) => [index, game.scheduledAt])).toEqual([[0, '2026-11-01T01:00:00.000Z'], [1, '2026-11-01T03:00:00.000Z']]);
  });
});

describe('conflict details', () => {
  it('names the conflict type, the team and the related game', () => {
    const options = { ...twoSundays, maxGamesPerTeamPerDay: 1, teamUnavailability: [{ teamId: 'c', dates: ['2026-11-01'] }] };
    const existing = [{ id: 'old-1', homeTeamId: 'x', awayTeamId: 'y', scheduledAt: '2026-11-01T01:00:00Z', venueId: 'court-b', durationMinutes: 60 }];
    const issues = scheduleIssues([
      draft('a', 'b', '2026-11-01T01:00:00Z'),
      draft('a', 'c', '2026-11-01T01:30:00Z', 2, 'court-b'),
    ], options, existing);
    expect(issues).toEqual(expect.arrayContaining([
      { index: 0, type: 'team', teamId: 'a', message: expect.stringMatching(/team conflict/i), with: { kind: 'draft', index: 1 } },
      { index: 1, type: 'team', teamId: 'a', message: expect.stringMatching(/team conflict/i), with: { kind: 'draft', index: 0 } },
      { index: 1, type: 'venue', message: expect.stringMatching(/already booked/i), with: { kind: 'existing', id: 'old-1' } },
      { index: 1, type: 'unavailable', teamId: 'c', message: expect.stringMatching(/unavailable/i) },
      { index: 0, type: 'daily_limit', teamId: 'a', message: expect.stringMatching(/daily limit/i) },
      { index: 1, type: 'round', teamId: 'a', message: expect.stringMatching(/round sequence/i), with: { kind: 'draft', index: 0 } },
    ]));
    expect(scheduleIssues([draft('a', 'b', '2026-11-01T07:00:00Z')], options, [])).toEqual([{ index: 0, type: 'window', message: 'Game outside availability window' }]);
  });

  it('keeps the issue list bounded when many games overlap', () => {
    const options = { ...twoSundays, venueIds: ['court-a'] };
    const games = Array.from({ length: 120 }, (_, i) => draft('h' + i, 'a' + i, '2026-11-01T01:00:00Z'));
    const issues = scheduleIssues(games, options, []);
    expect(new Set(issues.map((issue) => issue.index)).size).toBe(120);
    for (let index = 0; index < 120; index++) expect(issues.filter((issue) => issue.index === index && issue.type === 'venue').length).toBeLessThanOrEqual(3);
  });
});

describe('slot suggestions', () => {
  const options: ScheduleAvailability = { ...twoSundays, restMinutes: 30, maxGamesPerTeamPerDay: 1 };

  it('suggests the next open times that pass every check', () => {
    const drafts = [draft('a', 'b', '2026-11-01T01:00:00Z'), draft('c', 'd', '2026-11-01T01:00:00Z', 1, 'court-b'), draft('c', 'e', '2026-11-08T01:00:00Z', 2)];
    const existing = [{ id: 'old', homeTeamId: 'x', awayTeamId: 'y', scheduledAt: '2026-11-01T02:00:00Z', venueId: 'court-a', durationMinutes: 60 }];
    const slots = suggestSlots(fixture('e', 'f'), drafts, options, existing);
    expect(slots).toEqual([
      { scheduledAt: '2026-11-01T02:00:00.000Z', venueId: 'court-b' },
      { scheduledAt: '2026-11-01T03:00:00.000Z', venueId: 'court-a' },
      { scheduledAt: '2026-11-01T04:00:00.000Z', venueId: 'court-a' },
    ]);
    for (const slot of slots) {
      expect(scheduleIssues([...drafts, { ...fixture('e', 'f'), ...slot, durationMinutes: 60 }], options, existing).filter((issue) => issue.index === 3)).toEqual([]);
    }
  });

  it('keeps a team round order and its daily limit', () => {
    const drafts = [draft('a', 'b', '2026-11-01T01:00:00Z', 1)];
    const slots = suggestSlots(fixture('a', 'c', 2), drafts, options, []);
    expect(slots.every((slot) => slot.scheduledAt.startsWith('2026-11-08'))).toBe(true);
    expect(slots).toHaveLength(3);
  });

  it('returns no suggestions when nothing is open', () => {
    expect(suggestSlots(fixture('a', 'b'), [], { ...options, blackoutDates: ['2026-11-01', '2026-11-08'] }, [])).toEqual([]);
  });
});

