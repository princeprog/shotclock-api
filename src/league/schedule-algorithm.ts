export type ScheduleAvailability = {
  startDate: string;
  endDate: string;
  windows: { weekdays: number[]; startTime: string; endTime: string }[];
  timeZone: string;
  venueIds: string[];
  durationMinutes: number;
  restMinutes: number;
};

export type ScheduleMatch = {
  homeTeamId: string;
  awayTeamId: string;
  round: number;
  stage: 'preliminary' | 'semifinal' | 'final' | 'third_place';
};

export type ScheduleGame = ScheduleMatch & {
  scheduledAt: string;
  venueId: string;
  durationMinutes: number;
};

export type ExistingGame = {
  homeTeamId: string;
  awayTeamId: string;
  scheduledAt: string;
  venueId: string | null;
  durationMinutes: number | null;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_GAMES = 10_000;
const MAX_COMPARISONS = 5_000_000;
type Interval = { start: number; end: number };
type BusyGame = Interval & {
  homeTeamId: string;
  awayTeamId: string;
  venueId: string | null;
};

function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function date(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('Invalid date');
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value ||
    value < '2000-01-01' ||
    value > '2100-12-31'
  )
    throw new Error(
      'Invalid date: expected a calendar date from 2000 through 2100',
    );
  return parsed;
}

function time(value: string): number {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error('Invalid time: expected HH:mm');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function instant(value: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(
      value,
    )
  )
    throw new Error(
      'Invalid scheduledAt: expected an ISO timestamp with timezone',
    );
  const calendarDay = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(calendarDay) ||
    new Date(calendarDay).toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw new Error('Invalid scheduledAt calendar date');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid scheduledAt');
  return result;
}

function duration(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid ${name}`);
}

function validateMatch(match: ScheduleMatch): void {
  if (
    !match ||
    !id(match.homeTeamId) ||
    !id(match.awayTeamId) ||
    match.homeTeamId === match.awayTeamId
  )
    throw new Error('Invalid match teams');
  if (
    !Number.isSafeInteger(match.round) ||
    match.round < 1 ||
    !['preliminary', 'semifinal', 'final', 'third_place'].includes(match.stage)
  )
    throw new Error('Invalid match round or stage');
}

export function roundRobin(
  teamIds: string[],
  format: 'single' | 'double',
): ScheduleMatch[] {
  if (
    !Array.isArray(teamIds) ||
    teamIds.length > 100 ||
    teamIds.some((team) => !id(team)) ||
    new Set(teamIds).size !== teamIds.length
  )
    throw new Error('Invalid team IDs (maximum 100 distinct teams)');
  if (format !== 'single' && format !== 'double')
    throw new Error('Invalid round robin format');
  if (teamIds.length < 2) return [];
  const positions: (number | null)[] = teamIds.map((_, index) => index);
  if (positions.length % 2) positions.push(null);
  const rounds = positions.length - 1;
  const matches: ScheduleMatch[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < positions.length / 2; i++) {
      const first = positions[i];
      const second = positions[positions.length - 1 - i];
      if (first === null || second === null) continue;
      const distance = (second - first + teamIds.length) % teamIds.length;
      const firstHome =
        distance < teamIds.length / 2 ||
        (distance === teamIds.length / 2 && first < second);
      matches.push({
        homeTeamId: teamIds[firstHome ? first : second],
        awayTeamId: teamIds[firstHome ? second : first],
        round,
        stage: 'preliminary',
      });
    }
    positions.splice(1, 0, positions.pop()!);
  }
  if (format === 'double')
    return [
      ...matches,
      ...matches.map((match) => ({
        ...match,
        homeTeamId: match.awayTeamId,
        awayTeamId: match.homeTeamId,
        round: match.round + rounds,
      })),
    ];
  return matches;
}

function settings(availability: ScheduleAvailability): {
  start: number;
  end: number;
  weeklyWindows: Interval[][];
  formatter: Intl.DateTimeFormat;
} {
  if (!availability) throw new Error('Invalid availability');
  const start = date(availability.startDate);
  const end = date(availability.endDate);
  if (end < start || end - start >= 366 * DAY)
    throw new Error('Invalid date range: maximum 366 inclusive days');
  if (
    !Array.isArray(availability.windows) ||
    !availability.windows.length ||
    availability.windows.length > 20
  )
    throw new Error('Invalid windows: expected 1 to 20 weekly windows');
  const weeklyWindows: Interval[][] = Array.from({ length: 7 }, () => []);
  for (const window of availability.windows) {
    if (
      !window ||
      !Array.isArray(window.weekdays) ||
      !window.weekdays.length ||
      window.weekdays.length > 7 ||
      window.weekdays.some(
        (day) => !Number.isInteger(day) || day < 0 || day > 6,
      ) ||
      new Set(window.weekdays).size !== window.weekdays.length
    )
      throw new Error('Invalid weekdays');
    const start = time(window.startTime);
    const end = time(window.endTime);
    if (start >= end)
      throw new Error('Invalid time window: end must be later than start');
    for (const day of window.weekdays) weeklyWindows[day].push({ start, end });
  }
  if (
    !Array.isArray(availability.venueIds) ||
    !availability.venueIds.length ||
    availability.venueIds.length > 100 ||
    availability.venueIds.some((venue) => !id(venue)) ||
    new Set(availability.venueIds).size !== availability.venueIds.length
  )
    throw new Error('Invalid venue IDs');
  duration(availability.durationMinutes, 'durationMinutes', 1, 1440);
  duration(availability.restMinutes, 'restMinutes', 0, 10080);
  let formatter: Intl.DateTimeFormat;
  try {
    if (
      typeof availability.timeZone !== 'string' ||
      !availability.timeZone ||
      /^[+-]/.test(availability.timeZone)
    )
      throw new Error();
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: availability.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error('Invalid IANA timeZone');
  }
  return { start, end, weeklyWindows, formatter };
}

// Scan real minutes rather than guessing offsets: DST gaps disappear and folds occur twice.
function windows(config: ReturnType<typeof settings>): Interval[] {
  const days = new Map<string, Interval[]>();
  for (let day = config.start; day <= config.end; day += DAY) {
    const weekdayWindows = config.weeklyWindows[new Date(day).getUTCDay()];
    if (weekdayWindows.length)
      days.set(new Date(day).toISOString().slice(0, 10), weekdayWindows);
  }
  const intervals: Interval[] = [];
  let current: Interval | undefined;
  for (let at = config.start - DAY; at < config.end + 2 * DAY; at += MINUTE) {
    const parts = config.formatter.formatToParts(at);
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? '';
    const localDate = `${get('year')}-${get('month')}-${get('day')}`;
    const localTime = Number(get('hour')) * 60 + Number(get('minute'));
    const inWindow =
      days
        .get(localDate)
        ?.some(
          (window) => localTime >= window.start && localTime < window.end,
        ) ?? false;
    if (inWindow) {
      if (!current) {
        current = { start: at, end: at + MINUTE };
        intervals.push(current);
      } else current.end = at + MINUTE;
    } else current = undefined;
  }
  return intervals;
}

function busyGames(
  existing: ExistingGame[],
  availability: ScheduleAvailability,
): BusyGame[] {
  if (!Array.isArray(existing) || existing.length > MAX_GAMES)
    throw new Error('Invalid existing games (maximum 10000)');
  return existing.map((game) => {
    if (
      !game ||
      !id(game.homeTeamId) ||
      !id(game.awayTeamId) ||
      game.homeTeamId === game.awayTeamId ||
      (game.venueId !== null && !id(game.venueId))
    )
      throw new Error('Invalid existing game');
    const start = instant(game.scheduledAt);
    const minutes = game.durationMinutes ?? availability.durationMinutes;
    duration(minutes, 'existing durationMinutes', 1, 1440);
    return {
      start,
      end: start + minutes * MINUTE,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      venueId: game.venueId,
    };
  });
}

function conflict(
  candidate: BusyGame,
  previous: BusyGame,
  rest: number,
): boolean {
  const sameTeam =
    candidate.homeTeamId === previous.homeTeamId ||
    candidate.homeTeamId === previous.awayTeamId ||
    candidate.awayTeamId === previous.homeTeamId ||
    candidate.awayTeamId === previous.awayTeamId;
  if (
    sameTeam &&
    candidate.start < previous.end + rest &&
    previous.start < candidate.end + rest
  )
    return true;
  return (
    candidate.venueId !== null &&
    candidate.venueId === previous.venueId &&
    candidate.start < previous.end &&
    previous.start < candidate.end
  );
}

export function scheduleMatches(
  matches: ScheduleMatch[],
  availability: ScheduleAvailability,
  existing: ExistingGame[],
): ScheduleGame[] {
  const config = settings(availability);
  if (!Array.isArray(matches) || matches.length > MAX_GAMES)
    throw new Error('Invalid matches (maximum 10000)');
  matches.forEach(validateMatch);
  const busy = busyGames(existing, availability);
  if (!matches.length) return [];
  if (
    matches.length *
      (busy.length + matches.length) *
      availability.venueIds.length >
    MAX_COMPARISONS
  )
    throw new Error('Scheduling input exceeds work limit');
  const intervals = windows(config);
  const result: ScheduleGame[] = [];
  const rest = availability.restMinutes * MINUTE;
  const ordered = matches
    .map((match, index) => ({ match, index }))
    .sort((a, b) => a.match.round - b.match.round || a.index - b.index);
  let currentRound = ordered[0].match.round;
  let roundStart = -Infinity;
  let roundEnd = -Infinity;
  for (const { match, index: matchIndex } of ordered) {
    if (match.round !== currentRound) {
      currentRound = match.round;
      roundStart = roundEnd;
    }
    let selected: BusyGame | undefined;
    for (const venueId of availability.venueIds) {
      const blocked: Interval[] = [];
      for (const item of busy) {
        const sameTeam =
          item.homeTeamId === match.homeTeamId ||
          item.awayTeamId === match.homeTeamId ||
          item.homeTeamId === match.awayTeamId ||
          item.awayTeamId === match.awayTeamId;
        if (sameTeam || item.venueId === venueId)
          blocked.push({
            start: item.start - (sameTeam ? rest : 0),
            end: item.end + (sameTeam ? rest : 0),
          });
      }
      blocked.sort((a, b) => a.start - b.start);
      let blockedIndex = 0;
      for (const interval of intervals) {
        let start = Math.max(
          interval.start,
          Math.ceil(roundStart / MINUTE) * MINUTE,
        );
        const length = availability.durationMinutes * MINUTE;
        while (
          blockedIndex < blocked.length &&
          blocked[blockedIndex].end <= start
        )
          blockedIndex++;
        let index = blockedIndex;
        while (
          index < blocked.length &&
          blocked[index].start < start + length
        ) {
          if (blocked[index].end > start)
            start = Math.ceil(blocked[index].end / MINUTE) * MINUTE;
          index++;
        }
        if (
          start + length <= interval.end &&
          (!selected || start < selected.start)
        )
          selected = { ...match, venueId, start, end: start + length };
        if (selected && selected.start <= interval.end) break;
      }
    }
    if (!selected)
      throw new Error(
        'Unable to schedule all matches: insufficient capacity or no placement found by the greedy search',
      );
    busy.push(selected);
    roundEnd = Math.max(roundEnd, selected.end);
    result[matchIndex] = {
      ...match,
      scheduledAt: new Date(selected.start).toISOString(),
      venueId: selected.venueId!,
      durationMinutes: availability.durationMinutes,
    };
  }
  return result;
}

export function validateSchedule(
  games: ScheduleGame[],
  availability: ScheduleAvailability,
  existing: ExistingGame[],
): void {
  const config = settings(availability);
  if (!Array.isArray(games) || games.length > MAX_GAMES)
    throw new Error('Invalid games (maximum 10000)');
  const busy = busyGames(existing, availability);
  if (!games.length) return;
  if (games.length * (busy.length + games.length) > MAX_COMPARISONS)
    throw new Error('Schedule validation input exceeds work limit');
  const intervals = windows(config);
  const rounds = new Map<number, Interval>();
  for (const game of games) {
    validateMatch(game);
    if (!availability.venueIds.includes(game.venueId))
      throw new Error('Invalid game venue');
    duration(game.durationMinutes, 'game durationMinutes', 1, 1440);
    if (game.durationMinutes !== availability.durationMinutes)
      throw new Error(
        'Game durationMinutes must equal availability durationMinutes',
      );
    const start = instant(game.scheduledAt);
    const candidate: BusyGame = {
      ...game,
      start,
      end: start + game.durationMinutes * MINUTE,
    };
    if (
      !intervals.some(
        (interval) =>
          candidate.start >= interval.start && candidate.end <= interval.end,
      )
    )
      throw new Error('Game outside availability window');
    if (
      busy.some((item) =>
        conflict(candidate, item, availability.restMinutes * MINUTE),
      )
    )
      throw new Error('Game conflict: team, rest, or venue');
    busy.push(candidate);
    const round = rounds.get(game.round);
    if (round) {
      round.start = Math.min(round.start, candidate.start);
      round.end = Math.max(round.end, candidate.end);
    } else
      rounds.set(game.round, { start: candidate.start, end: candidate.end });
  }
  let lastEnd = -Infinity;
  for (const [, round] of [...rounds].sort(([a], [b]) => a - b)) {
    if (round.start < lastEnd)
      throw new Error(
        'Round sequence conflict: a later round starts before an earlier round ends',
      );
    lastEnd = round.end;
  }
}
