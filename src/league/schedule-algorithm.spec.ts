import {
  roundRobin,
  scheduleMatches,
  validateSchedule,
  estimateCourtCapacity,
  scheduleIssues,
} from './schedule-algorithm';
import type {
  ExistingGame,
  ScheduleAvailability,
  ScheduleGame,
  ScheduleMatch,
} from './schedule-algorithm';

const match = (
  homeTeamId: string,
  awayTeamId: string,
  round = 1,
): ScheduleMatch => ({
  homeTeamId,
  awayTeamId,
  round,
  stage: 'preliminary',
});
const availability: ScheduleAvailability = {
  startDate: '2026-11-01',
  endDate: '2026-11-01',
  windows: [{ weekdays: [0], startTime: '09:00', endTime: '13:00' }],
  timeZone: 'Asia/Manila',
  venueIds: ['court-a', 'court-b'],
  durationMinutes: 60,
  restMinutes: 30,
};
const game = (overrides: Partial<ScheduleGame> = {}): ScheduleGame => ({
  ...match('a', 'b'),
  scheduledAt: '2026-11-01T01:00:00.000Z',
  venueId: 'court-a',
  durationMinutes: 60,
  ...overrides,
});

describe('schedule preview diagnostics', () => {
  it('counts free court capacity after overlapping bookings and legacy durations', () => {
    const existing: ExistingGame[] = [
      { homeTeamId: 'x', awayTeamId: 'y', scheduledAt: '2026-11-01T01:30:00.000Z', venueId: 'court-a', durationMinutes: null },
      { homeTeamId: 'q', awayTeamId: 'r', scheduledAt: '2026-11-01T02:00:00.000Z', venueId: 'court-a', durationMinutes: 60 },
    ];
    expect(estimateCourtCapacity(availability, existing)).toBe(6);
  });
  it('identifies both draft games involved in venue and rest conflicts', () => {
    const games = [game(), game({ homeTeamId: 'a', awayTeamId: 'c', scheduledAt: '2026-11-01T01:30:00.000Z' })];
    const issues = scheduleIssues(games, availability, []);
    expect(new Set(issues.map((issue) => issue.index))).toEqual(new Set([0, 1]));
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/team.*rest/i);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/venue.*booked/i);
  });
  it('merges overlapping windows and counts elapsed time across DST', () => {
    const spring = { ...availability, startDate: '2026-03-08', endDate: '2026-03-08', timeZone: 'America/New_York', venueIds: ['court-a'], windows: [{ weekdays: [0], startTime: '01:30', endTime: '03:30' }, { weekdays: [0], startTime: '03:00', endTime: '04:30' }] };
    expect(estimateCourtCapacity(spring, [])).toBe(2);
    const fall = { ...spring, startDate: '2026-11-01', endDate: '2026-11-01', windows: [{ weekdays: [0], startTime: '01:00', endTime: '02:00' }] };
    expect(estimateCourtCapacity(fall, [])).toBe(2);
  });
  it('marks both the earlier and later games when round order is broken', () => {
    const games = [game({ scheduledAt: '2026-11-01T03:00:00Z' }), game({ homeTeamId: 'c', awayTeamId: 'd', round: 2, scheduledAt: '2026-11-01T02:00:00Z' })];
    const issues = scheduleIssues(games, availability, []);
    expect(issues.filter((issue) => /round sequence/i.test(issue.message)).map((issue) => issue.index).sort()).toEqual([0, 1]);
  });
});

describe('roundRobin', () => {
  it.each([4, 5])(
    'plays every pair once with no team repeated in a round (%i teams)',
    (count) => {
      const teams = Array.from({ length: count }, (_, i) => `team-${i}`);
      const matches = roundRobin(teams, 'single');
      expect(matches).toHaveLength((count * (count - 1)) / 2);
      const pairs = new Set(
        matches.map(({ homeTeamId, awayTeamId }) =>
          [homeTeamId, awayTeamId].sort().join(':'),
        ),
      );
      expect(pairs.size).toBe(matches.length);
      const rounds = new Set(matches.map((item) => item.round));
      expect(rounds.size).toBe(count % 2 ? count : count - 1);
      for (const round of rounds) {
        const players = matches
          .filter((item) => item.round === round)
          .flatMap((item) => [item.homeTeamId, item.awayTeamId]);
        expect(new Set(players).size).toBe(players.length);
        expect(players).toHaveLength(count - (count % 2));
      }
      const homeCounts = teams.map(
        (team) => matches.filter((item) => item.homeTeamId === team).length,
      );
      expect(
        Math.max(...homeCounts) - Math.min(...homeCounts),
      ).toBeLessThanOrEqual(1);
      expect(matches.every((item) => item.stage === 'preliminary')).toBe(true);
    },
  );

  it('reverses each fixture in the second leg with subsequent rounds', () => {
    const single = roundRobin(['a', 'b', 'c', 'd', 'e'], 'single');
    const doubled = roundRobin(['a', 'b', 'c', 'd', 'e'], 'double');
    expect(doubled.slice(0, single.length)).toEqual(single);
    expect(doubled.slice(single.length)).toEqual(
      single.map((item) => ({
        ...item,
        homeTeamId: item.awayTeamId,
        awayTeamId: item.homeTeamId,
        round: item.round + 5,
      })),
    );
  });

  it('handles small inputs and rejects duplicate teams', () => {
    expect(roundRobin([], 'single')).toEqual([]);
    expect(roundRobin(['a'], 'single')).toEqual([]);
    expect(() => roundRobin(['a', 'a'], 'single')).toThrow();
  });

  it('balances home assignments and byes across a range of league sizes', () => {
    for (let size = 2; size <= 25; size++) {
      const teams = Array.from({ length: size }, (_, i) => String(i));
      const matches = roundRobin(teams, 'single');
      const homes = teams.map(
        (team) => matches.filter((item) => item.homeTeamId === team).length,
      );
      expect(Math.max(...homes) - Math.min(...homes)).toBeLessThanOrEqual(1);
      expect(matches).toHaveLength((size * (size - 1)) / 2);
    }
  });
});

describe('scheduleMatches and validateSchedule', () => {
  it('explains when selected weekdays do not occur in the date range', () => {
    const options = { ...availability, windows: [{ weekdays: [1], startTime: '09:00', endTime: '17:00' }] };
    expect(() => scheduleMatches([match('a', 'b')], options, [])).toThrow(/no selected playing days.*date range/i);
  });

  it('explains when playing windows are shorter than the game duration', () => {
    const options = { ...availability, windows: [{ weekdays: [0], startTime: '09:00', endTime: '09:30' }] };
    expect(() => scheduleMatches([match('a', 'b')], options, [])).toThrow(/longest playing window is 30 minutes.*60-minute game/i);
  });

  it('reports a proven court-slot shortfall and the number left unscheduled', () => {
    const options = { ...availability, venueIds: ['court-a'], windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }] };
    expect(() => scheduleMatches([match('a', 'b'), match('c', 'd')], options, [])).toThrow(/1 of 2 games.*1 game remaining.*at most 1 game.*2 games/i);
  });

  it('identifies a minimum-rest constraint in the current attempted schedule', () => {
    const options = { ...availability, venueIds: ['court-a', 'court-b'], windows: [{ weekdays: [0], startTime: '09:00', endTime: '11:00' }] };
    expect(() => scheduleMatches([match('a', 'b'), match('a', 'c')], options, [])).toThrow(/minimum rest.*30 minutes/i);
  });

  it('identifies occupied venues in the current attempted schedule', () => {
    const options = { ...availability, venueIds: ['court-a'], windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }] };
    const existing: ExistingGame[] = [{ homeTeamId: 'x', awayTeamId: 'y', scheduledAt: '2026-11-01T01:00:00Z', venueId: 'court-a', durationMinutes: 60 }];
    expect(() => scheduleMatches([match('a', 'b')], options, existing)).toThrow(/selected venues.*occupied/i);
  });

  it('explains when the round order prevents using an earlier available slot', () => {
    const options = { ...availability, restMinutes: 0, windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }] };
    expect(() => scheduleMatches([match('a', 'b', 1), match('c', 'd', 2)], options, [])).toThrow(/slot exists earlier.*round must follow the previous round/i);
  });

  it('does not claim a single cause when several constraints block the attempt', () => {
    const options = { ...availability, restMinutes: 0, windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }] };
    const existing: ExistingGame[] = [
      { homeTeamId: 'a', awayTeamId: 'x', scheduledAt: '2026-11-01T01:00:00Z', venueId: 'court-a', durationMinutes: 60 },
      { homeTeamId: 'y', awayTeamId: 'z', scheduledAt: '2026-11-01T01:00:00Z', venueId: 'court-b', durationMinutes: 60 },
    ];
    expect(() => scheduleMatches([match('a', 'b')], options, existing)).toThrow(/no slot in this attempt.*different arrangement may also work.*no games were saved/i);
  });
  it('uses separate Saturday morning and Sunday evening windows', () => {
    const options = {
      ...availability,
      startDate: '2026-11-07',
      endDate: '2026-11-08',
      venueIds: ['court-a'],
      windows: [
        { weekdays: [6], startTime: '09:00', endTime: '10:00' },
        { weekdays: [0], startTime: '18:00', endTime: '19:00' },
      ],
    };
    const games = scheduleMatches(
      [match('a', 'b', 1), match('c', 'd', 2)],
      options,
      [],
    );
    expect(games.map((item) => item.scheduledAt)).toEqual([
      '2026-11-07T01:00:00.000Z',
      '2026-11-08T10:00:00.000Z',
    ]);
    expect(() => validateSchedule(games, options, [])).not.toThrow();
  });

  it('unions overlapping windows for a game spanning their overlap', () => {
    const options = {
      ...availability,
      venueIds: ['court-a'],
      durationMinutes: 90,
      windows: [
        { weekdays: [0], startTime: '09:00', endTime: '10:00' },
        { weekdays: [0], startTime: '09:30', endTime: '11:00' },
      ],
    };
    const games = scheduleMatches([match('a', 'b')], options, []);
    expect(games[0].scheduledAt).toBe('2026-11-01T01:00:00.000Z');
    expect(() => validateSchedule(games, options, [])).not.toThrow();
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-01T02:00:00Z', durationMinutes: 90 })],
        options,
        [],
      ),
    ).toThrow(/window/i);
    expect(() =>
      scheduleMatches([match('a', 'b'), match('c', 'd')], options, []),
    ).toThrow(/at most 1 game/i);
  });

  it('rejects games that bridge a gap between windows', () => {
    const options = {
      ...availability,
      windows: [
        { weekdays: [0], startTime: '09:00', endTime: '10:00' },
        { weekdays: [0], startTime: '10:30', endTime: '12:00' },
      ],
    };
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-01T01:30:00Z' })],
        options,
        [],
      ),
    ).toThrow(/window/i);
    expect(
      scheduleMatches(
        [match('a', 'b'), match('c', 'd')],
        { ...options, venueIds: ['court-a'] },
        [],
      ).map((item) => item.scheduledAt),
    ).toEqual(['2026-11-01T01:00:00.000Z', '2026-11-01T02:30:00.000Z']);
  });

  it('validates every window and caps the number of windows and weekdays', () => {
    const valid = { weekdays: [0], startTime: '09:00', endTime: '10:00' };
    expect(() =>
      scheduleMatches(
        [],
        { ...availability, windows: Array.from({ length: 20 }, () => valid) },
        [],
      ),
    ).not.toThrow();
    expect(() =>
      scheduleMatches([], { ...availability, windows: [] }, []),
    ).toThrow(/windows/i);
    expect(() =>
      scheduleMatches(
        [],
        { ...availability, windows: Array.from({ length: 21 }, () => valid) },
        [],
      ),
    ).toThrow(/windows/i);
    for (const invalid of [
      { ...valid, weekdays: [] },
      { ...valid, weekdays: [0, 1, 2, 3, 4, 5, 6, 0] },
      { ...valid, weekdays: [1, 1] },
      { ...valid, weekdays: [-1] },
      { ...valid, startTime: '25:00' },
      { ...valid, endTime: '09:00' },
    ]) {
      expect(() =>
        scheduleMatches([], { ...availability, windows: [valid, invalid] }, []),
      ).toThrow();
    }
  });
  it('keeps every generated double round robin round after the previous one', () => {
    const options = {
      ...availability,
      windows: [{ weekdays: [0], startTime: '09:00', endTime: '17:00' }],
      restMinutes: 0,
    };
    const games = scheduleMatches(
      roundRobin(['a', 'b', 'c', 'd'], 'double'),
      options,
      [],
    );
    for (let round = 1; round < 6; round++) {
      const end = Math.max(
        ...games
          .filter((item) => item.round === round)
          .map(
            (item) =>
              Date.parse(item.scheduledAt) + item.durationMinutes * 60_000,
          ),
      );
      const nextStart = Math.min(
        ...games
          .filter((item) => item.round === round + 1)
          .map((item) => Date.parse(item.scheduledAt)),
      );
      expect(nextStart).toBeGreaterThanOrEqual(end);
    }
    expect(() => validateSchedule(games, options, [])).not.toThrow();
  });
  it('schedules rounds in order even when matches arrive out of order', () => {
    const existing: ExistingGame[] = [
      {
        homeTeamId: 'e',
        awayTeamId: 'x',
        scheduledAt: '2026-11-01T01:00:00Z',
        venueId: null,
        durationMinutes: 60,
      },
    ];
    const games = scheduleMatches(
      [match('c', 'd', 2), match('a', 'b', 1), match('e', 'f', 1)],
      availability,
      existing,
    );
    expect(games.map((item) => item.scheduledAt)).toEqual([
      '2026-11-01T03:30:00.000Z',
      '2026-11-01T01:00:00.000Z',
      '2026-11-01T02:30:00.000Z',
    ]);
    expect(() => validateSchedule(games, availability, existing)).not.toThrow();
  });

  it('rejects previews that overlap rounds or change the configured duration', () => {
    const firstRound = game({
      ...match('a', 'b', 1),
      scheduledAt: '2026-11-01T02:30:00Z',
    });
    const secondRound = game({
      ...match('c', 'd', 2),
      scheduledAt: '2026-11-01T03:00:00Z',
      venueId: 'court-b',
    });
    expect(() =>
      validateSchedule([secondRound, firstRound], availability, []),
    ).toThrow(/round/i);
    expect(() =>
      validateSchedule([game({ durationMinutes: 30 })], availability, []),
    ).toThrow(/duration/i);
    expect(() =>
      validateSchedule([game({ durationMinutes: 90 })], availability, []),
    ).toThrow(/duration/i);
    expect(() =>
      validateSchedule(
        [{ ...secondRound, scheduledAt: '2026-11-01T03:30:00Z' }, firstRound],
        availability,
        [],
      ),
    ).not.toThrow();
  });
  it('schedules simultaneous independent games, enforces rest, and validates the result', () => {
    const games = scheduleMatches(
      [match('a', 'b'), match('c', 'd'), match('a', 'c', 2)],
      availability,
      [],
    );
    expect(games.map((item) => [item.scheduledAt, item.venueId])).toEqual([
      ['2026-11-01T01:00:00.000Z', 'court-a'],
      ['2026-11-01T01:00:00.000Z', 'court-b'],
      ['2026-11-01T02:30:00.000Z', 'court-a'],
    ]);
    expect(() => validateSchedule(games, availability, [])).not.toThrow();
  });

  it('accounts for existing venue and team conflicts, including null duration and venue', () => {
    const existing: ExistingGame[] = [
      {
        homeTeamId: 'x',
        awayTeamId: 'y',
        scheduledAt: '2026-11-01T01:00:00Z',
        venueId: 'court-a',
        durationMinutes: null,
      },
      {
        homeTeamId: 'a',
        awayTeamId: 'z',
        scheduledAt: '2026-11-01T01:00:00Z',
        venueId: null,
        durationMinutes: null,
      },
    ];
    const games = scheduleMatches([match('a', 'b')], availability, existing);
    expect(games[0].scheduledAt).toBe('2026-11-01T02:30:00.000Z');
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-01T02:00:00Z' })],
        availability,
        existing,
      ),
    ).toThrow(/conflict|rest/i);
    expect(() => validateSchedule([game()], availability, existing)).toThrow(
      /conflict/i,
    );
  });

  it('finds a minute-aligned gap after a future existing game and applies its actual duration', () => {
    const existing: ExistingGame[] = [
      {
        homeTeamId: 'a',
        awayTeamId: 'x',
        scheduledAt: '2026-11-01T01:20:00Z',
        venueId: null,
        durationMinutes: 20,
      },
      {
        homeTeamId: 'y',
        awayTeamId: 'z',
        scheduledAt: '2026-11-01T01:00:00Z',
        venueId: 'court-a',
        durationMinutes: 10,
      },
    ];
    const games = scheduleMatches(
      [match('a', 'b')],
      { ...availability, venueIds: ['court-a'] },
      existing,
    );
    expect(games[0].scheduledAt).toBe('2026-11-01T02:10:00.000Z');
    expect(() => validateSchedule(games, availability, existing)).not.toThrow();
  });

  it('does not apply team rest to unrelated games at the same venue', () => {
    const existing: ExistingGame[] = [
      {
        homeTeamId: 'x',
        awayTeamId: 'y',
        scheduledAt: '2026-11-01T01:00:00Z',
        venueId: 'court-a',
        durationMinutes: 60,
      },
    ];
    const games = scheduleMatches(
      [match('a', 'b')],
      { ...availability, venueIds: ['court-a'] },
      existing,
    );
    expect(games[0].scheduledAt).toBe('2026-11-01T02:00:00.000Z');
  });

  it('rejects out-of-window, unknown venue, overlap, and insufficient capacity', () => {
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-01T04:30:00Z' })],
        availability,
        [],
      ),
    ).toThrow(/window/i);
    expect(() =>
      validateSchedule([game({ venueId: 'other' })], availability, []),
    ).toThrow(/venue/i);
    expect(() =>
      validateSchedule(
        [game(), game({ ...match('c', 'd') })],
        availability,
        [],
      ),
    ).toThrow(/conflict/i);
    expect(() =>
      scheduleMatches(
        [match('a', 'b'), match('a', 'c')],
        {
          ...availability,
          windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }],
        },
        [],
      ),
    ).toThrow(/teams are already playing or resting/i);
  });

  it('uses local weekdays and changes offset at the spring DST transition', () => {
    const options = {
      ...availability,
      startDate: '2026-03-01',
      endDate: '2026-03-08',
      windows: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }],
      timeZone: 'America/New_York',
      venueIds: ['court-a'],
    };
    const games = scheduleMatches(
      [match('a', 'b'), match('c', 'd')],
      options,
      [],
    );
    expect(games.map((item) => item.scheduledAt)).toEqual([
      '2026-03-01T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
    ]);
    expect(() => validateSchedule(games, options, [])).not.toThrow();
  });

  it('handles nonexistent and repeated local times, and checks the entire game window', () => {
    const spring = {
      ...availability,
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      windows: [{ weekdays: [0], startTime: '02:00', endTime: '03:00' }],
      timeZone: 'America/New_York',
    };
    expect(() => scheduleMatches([match('a', 'b')], spring, [])).toThrow(
      /daylight-saving gap/i,
    );
    const fall = {
      ...availability,
      windows: [{ weekdays: [0], startTime: '01:30', endTime: '02:30' }],
      timeZone: 'America/New_York',
      durationMinutes: 60,
    };
    const games = scheduleMatches([match('a', 'b')], fall, []);
    expect(games[0].scheduledAt).toBe('2026-11-01T06:30:00.000Z');
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-01T05:30:00Z' })],
        fall,
        [],
      ),
    ).toThrow(/window/i);
  });

  it('uses elapsed time across the spring gap and both copies of a fall hour', () => {
    const spring = {
      ...availability,
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      windows: [
        { weekdays: [0], startTime: '01:30', endTime: '02:00' },
        { weekdays: [0], startTime: '03:00', endTime: '03:30' },
      ],
      timeZone: 'America/New_York',
    };
    expect(scheduleMatches([match('a', 'b')], spring, [])[0].scheduledAt).toBe(
      '2026-03-08T06:30:00.000Z',
    );
    const fall = {
      ...availability,
      windows: [
        { weekdays: [0], startTime: '01:00', endTime: '01:30' },
        { weekdays: [0], startTime: '01:30', endTime: '02:00' },
      ],
      timeZone: 'America/New_York',
      venueIds: ['court-a'],
    };
    const games = scheduleMatches([match('a', 'b'), match('c', 'd')], fall, []);
    expect(games.map((item) => item.scheduledAt)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
    ]);
    expect(() => validateSchedule(games, fall, [])).not.toThrow();
  });

  it('rejects invalid and unbounded input promptly', () => {
    expect(() =>
      scheduleMatches(
        [],
        { ...availability, startDate: '2020-01-01', endDate: '2030-01-01' },
        [],
      ),
    ).toThrow(/range/i);
    expect(() =>
      scheduleMatches([], { ...availability, durationMinutes: 0 }, []),
    ).toThrow(/duration/i);
    expect(() =>
      scheduleMatches([], { ...availability, timeZone: 'Invalid/Zone' }, []),
    ).toThrow(/zone/i);
    expect(() =>
      scheduleMatches(
        [],
        {
          ...availability,
          windows: [{ weekdays: [7], startTime: '09:00', endTime: '10:00' }],
        },
        [],
      ),
    ).toThrow(/weekday/i);
    expect(() =>
      validateSchedule([game({ scheduledAt: 'not a date' })], availability, []),
    ).toThrow(/scheduledAt/i);
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-02-30T01:00:00Z' })],
        availability,
        [],
      ),
    ).toThrow(/scheduledAt/i);
    expect(() =>
      scheduleMatches([], { ...availability, startDate: '2026-02-30' }, []),
    ).toThrow(/date/i);
    expect(() =>
      scheduleMatches(
        Array.from({ length: 300 }, () => match('a', 'b')),
        {
          ...availability,
          venueIds: Array.from({ length: 100 }, (_, i) => `v${i}`),
        },
        [],
      ),
    ).toThrow(/work limit/i);
  });

  it('allows games at exact rest and venue boundaries and checks conflicts in either order', () => {
    const first = game();
    const next = game({
      ...match('a', 'c'),
      scheduledAt: '2026-11-01T02:30:00Z',
    });
    expect(() =>
      validateSchedule([next, first], availability, []),
    ).not.toThrow();
    expect(() =>
      validateSchedule(
        [
          game({ ...match('c', 'd'), scheduledAt: '2026-11-01T02:00:00Z' }),
          first,
        ],
        availability,
        [],
      ),
    ).not.toThrow();
    expect(() =>
      validateSchedule(
        [next, game({ scheduledAt: '2026-11-01T01:01:00Z' })],
        availability,
        [],
      ),
    ).toThrow(/conflict/i);
  });

  it('rejects timestamps outside the selected local weekdays and dates', () => {
    const weekly = { ...availability, endDate: '2026-11-08' };
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-02T01:00:00Z' })],
        weekly,
        [],
      ),
    ).toThrow(/window/i);
    expect(() =>
      validateSchedule(
        [game({ scheduledAt: '2026-11-08T01:00:00+00:00' })],
        weekly,
        [],
      ),
    ).not.toThrow();
  });
});
