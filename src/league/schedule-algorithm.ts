export type ScheduleAvailability = {
  startDate: string;
  endDate: string;
  windows: { weekdays: number[]; startTime: string; endTime: string }[];
  timeZone: string;
  venueIds: string[];
  durationMinutes: number;
  restMinutes: number;
  blackoutDates?: string[];
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
export type Interval = { start: number; end: number };
type BusyGame = Interval & {
  homeTeamId: string;
  awayTeamId: string;
  venueId: string | null;
};

function placementMessage(match: ScheduleMatch, placed: number, total: number, reason: string, homeName?: string, awayName?: string): string {
  const subject = homeName && awayName ? `${homeName} vs ${awayName}` : 'a game';
  const remaining = total - placed;
  return `Could not schedule ${subject} in round ${match.round}. ${placed} of ${total} games placed in this attempt; ${remaining} ${remaining === 1 ? 'game' : 'games'} remaining. ${reason} No games were saved.`;
}

export class SchedulePlacementError extends Error {
  constructor(readonly match: ScheduleMatch, readonly placed: number, readonly total: number, readonly reason: string) {
    super(placementMessage(match, placed, total, reason));
    this.name = 'SchedulePlacementError';
  }

  withTeamNames(homeName?: string, awayName?: string): string {
    return placementMessage(this.match, this.placed, this.total, this.reason, homeName, awayName);
  }
}

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
  blackouts: Set<string>;
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
  const blackouts = dateSet(availability.blackoutDates, 'blackoutDates');
  return { start, end, weeklyWindows, formatter, blackouts };
}

function dateSet(values: string[] | undefined, name: string, maximum = 366): Set<string> {
  if (values === undefined) return new Set();
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`Invalid ${name}: expected at most ${maximum} dates`);
  const result = new Set<string>();
  for (const value of values) {
    try { date(value); } catch { throw new Error(`Invalid ${name}: expected calendar dates from 2000 through 2100`); }
    if (result.has(value)) throw new Error(`Invalid ${name}: dates must be unique`);
    result.add(value);
  }
  return result;
}

function localParts(formatter: Intl.DateTimeFormat, at: number): { date: string; minutes: number; offset: number } {
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { date, minutes, offset: Date.parse(`${date}T00:00:00Z`) + minutes * MINUTE - Math.floor(at / MINUTE) * MINUTE };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

// Each local day uses one UTC offset unless it is near a transition. Those days scan real minutes,
// so DST gaps disappear and folds occur twice, exactly as a minute-by-minute scan would find them.
function windows(config: ReturnType<typeof settings>): Interval[] {
  const intervals: Interval[] = [];
  for (let day = config.start; day <= config.end; day += DAY) {
    const localDate = new Date(day).toISOString().slice(0, 10);
    if (config.blackouts.has(localDate)) continue;
    const local = mergeIntervals(config.weeklyWindows[new Date(day).getUTCDay()]);
    if (!local.length) continue;
    const before = localParts(config.formatter, day - DAY).offset;
    const after = localParts(config.formatter, day + 2 * DAY).offset;
    if (before === after) {
      for (const window of local) intervals.push({ start: day + window.start * MINUTE - before, end: day + window.end * MINUTE - before });
      continue;
    }
    let current: Interval | undefined;
    for (let at = day - DAY; at < day + 2 * DAY; at += MINUTE) {
      const parts = localParts(config.formatter, at);
      const inWindow = parts.date === localDate && local.some((window) => parts.minutes >= window.start && parts.minutes < window.end);
      if (inWindow) {
        if (!current) {
          current = { start: at, end: at + MINUTE };
          intervals.push(current);
        } else current.end = at + MINUTE;
      } else current = undefined;
    }
  }
  return mergeIntervals(intervals);
}

export function playingIntervals(availability: ScheduleAvailability): Interval[] {
  return windows(settings(availability));
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

// An upper bound: venue occupancy is considered, but team rest and round order are not.
export function estimateCourtCapacity(availability: ScheduleAvailability, existing: ExistingGame[]): number {
  const intervals = windows(settings(availability));
  const busy = busyGames(existing, availability).filter((game) => {
    if (game.venueId === null || !availability.venueIds.includes(game.venueId)) return false;
    let low = 0, high = intervals.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (intervals[middle].end <= game.start) low = middle + 1;
      else high = middle;
    }
    return low < intervals.length && intervals[low].start < game.end;
  });
  if (intervals.length * Math.max(1, busy.length) > MAX_COMPARISONS)
    throw new Error('Schedule capacity input exceeds work limit');
  const length = availability.durationMinutes * MINUTE;
  let total = 0;
  for (const venueId of availability.venueIds) {
    const blocked = busy.filter((game) => game.venueId === venueId).sort((a, b) => a.start - b.start);
    for (const interval of intervals) {
      let cursor = interval.start;
      for (const item of blocked) {
        if (item.end <= cursor) continue;
        if (item.start >= interval.end) break;
        total += Math.floor(Math.max(0, item.start - cursor) / length);
        cursor = Math.max(cursor, item.end);
        if (cursor >= interval.end) break;
      }
      total += Math.floor(Math.max(0, interval.end - cursor) / length);
    }
  }
  return total;
}

function conflictReasons(
  candidate: BusyGame,
  previous: BusyGame,
  rest: number,
): string[] {
  const reasons: string[] = [];
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
    reasons.push('Team conflict: a team is playing or has insufficient rest. Choose another time.');
  if (
    candidate.venueId !== null &&
    candidate.venueId === previous.venueId &&
    candidate.start < previous.end &&
    previous.start < candidate.end
  ) reasons.push('Venue conflict: this court is already booked. Choose another time or venue.');
  return reasons;
}

function findPlacement(
  match: ScheduleMatch,
  availability: ScheduleAvailability,
  intervals: Interval[],
  busy: BusyGame[],
  earliest: number,
  options: { checkTeams: boolean; checkVenues: boolean; rest: number },
): BusyGame | undefined {
  let selected: BusyGame | undefined;
  for (const venueId of availability.venueIds) {
    const blocked: Interval[] = [];
    for (const item of busy) {
      const sameTeam = item.homeTeamId === match.homeTeamId || item.awayTeamId === match.homeTeamId ||
        item.homeTeamId === match.awayTeamId || item.awayTeamId === match.awayTeamId;
      const teamBlocked = options.checkTeams && sameTeam;
      if (teamBlocked || (options.checkVenues && item.venueId === venueId)) {
        blocked.push({ start: item.start - (teamBlocked ? options.rest : 0), end: item.end + (teamBlocked ? options.rest : 0) });
      }
    }
    blocked.sort((a, b) => a.start - b.start);
    let blockedIndex = 0;
    for (const interval of intervals) {
      let start = Math.max(interval.start, Math.ceil(earliest / MINUTE) * MINUTE);
      const length = availability.durationMinutes * MINUTE;
      while (blockedIndex < blocked.length && blocked[blockedIndex].end <= start) blockedIndex++;
      let index = blockedIndex;
      while (index < blocked.length && blocked[index].start < start + length) {
        if (blocked[index].end > start) start = Math.ceil(blocked[index].end / MINUTE) * MINUTE;
        index++;
      }
      if (start + length <= interval.end && (!selected || start < selected.start)) selected = { ...match, venueId, start, end: start + length };
      if (selected && selected.start <= interval.end) break;
    }
  }
  return selected;
}

function placementReason(
  match: ScheduleMatch,
  total: number,
  availability: ScheduleAvailability,
  config: ReturnType<typeof settings>,
  intervals: Interval[],
  busy: BusyGame[],
  roundStart: number,
): string {
  if (!intervals.length) {
    let hasSelectedDay = false;
    let hasBlackoutDay = false;
    for (let day = config.start; day <= config.end; day += DAY) {
      if (!config.weeklyWindows[new Date(day).getUTCDay()].length) continue;
      if (config.blackouts.has(new Date(day).toISOString().slice(0, 10))) hasBlackoutDay = true;
      else { hasSelectedDay = true; break; }
    }
    if (!hasSelectedDay && hasBlackoutDay) return 'Every selected playing day in the date range is a blackout date. Remove a blackout date or extend the date range.';
    return hasSelectedDay
      ? 'The selected playing windows do not occur on those dates in the chosen time zone; check for a daylight-saving gap or choose different hours.'
      : 'No selected playing days fall within the date range. Add a playing day or extend the date range.';
  }
  const longest = Math.max(...intervals.map((interval) => (interval.end - interval.start) / MINUTE));
  if (longest < availability.durationMinutes) {
    return `The longest playing window is ${longest} minutes, shorter than the ${availability.durationMinutes}-minute game. Extend a playing window or reduce the game duration.`;
  }
  const capacity = intervals.reduce((count, interval) => count + Math.floor((interval.end - interval.start) / (availability.durationMinutes * MINUTE)), 0) * availability.venueIds.length;
  if (capacity < total) {
    const shortfall = total - capacity;
    return `The selected windows and venues can fit at most ${capacity} ${capacity === 1 ? 'game' : 'games'}, but ${total} games are needed, even before conflicts and rest are considered. Add at least ${shortfall} more game ${shortfall === 1 ? 'slot' : 'slots'} by extending playing time or adding venues.`;
  }
  const checks = { checkTeams: true, checkVenues: true, rest: availability.restMinutes * MINUTE };
  if (checks.rest && findPlacement(match, availability, intervals, busy, roundStart, { ...checks, rest: 0 })) {
    return `In this attempted schedule, the minimum rest of ${availability.restMinutes} minutes leaves no available slot for this matchup. Add playing time or reduce the rest requirement. A different arrangement may also work.`;
  }
  if (Number.isFinite(roundStart) && findPlacement(match, availability, intervals, busy, -Infinity, checks)) {
    return 'A suitable slot exists earlier, but this round must follow the previous round. Add more playing time or extend the date range. A different arrangement may also work.';
  }
  if (findPlacement(match, availability, intervals, busy, roundStart, { ...checks, checkTeams: false })) {
    return 'In this attempted schedule, one or both teams are already playing or resting whenever a suitable slot is available. Add playing time or adjust the rest requirement. A different arrangement may also work.';
  }
  if (findPlacement(match, availability, intervals, busy, roundStart, { ...checks, checkVenues: false })) {
    return 'In this attempted schedule, the selected venues are occupied when this matchup could otherwise play. Add a venue or more playing time. A different arrangement may also work.';
  }
  return 'The selected times, venues, team availability, rest and round order leave no slot in this attempt. Add playing time or venues, or reduce rest. A different arrangement may also work.';
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
  for (const [placed, { match, index: matchIndex }] of ordered.entries()) {
    if (match.round !== currentRound) {
      currentRound = match.round;
      roundStart = roundEnd;
    }
    const selected = findPlacement(match, availability, intervals, busy, roundStart, { checkTeams: true, checkVenues: true, rest });
    if (!selected)
      throw new SchedulePlacementError(match, placed, matches.length, placementReason(match, matches.length, availability, config, intervals, busy, roundStart));
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
  const issues = scheduleIssues(games, availability, existing);
  if (issues.length) throw new Error(issues[0].message);
}

export function scheduleIssues(
  games: ScheduleGame[],
  availability: ScheduleAvailability,
  existing: ExistingGame[],
): { index: number; message: string }[] {
  const config = settings(availability);
  if (!Array.isArray(games) || games.length > MAX_GAMES)
    throw new Error('Invalid games (maximum 10000)');
  const busy = busyGames(existing, availability);
  if (!games.length) return [];
  if (games.length * (busy.length + games.length) > MAX_COMPARISONS)
    throw new Error('Schedule validation input exceeds work limit');
  const intervals = windows(config);
  const rounds = new Map<number, Interval>();
  const issues: { index: number; message: string }[] = [];
  const issueKeys = new Set<string>();
  const previousDraft: BusyGame[] = [];
  const addIssue = (index: number, message: string) => {
    const key = `${index}:${message}`;
    if (!issueKeys.has(key)) { issueKeys.add(key); issues.push({ index, message }); }
  };
  for (const [index, game] of games.entries()) {
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
      addIssue(index, 'Game outside availability window');
    for (const item of busy) for (const message of conflictReasons(candidate, item, availability.restMinutes * MINUTE)) addIssue(index, message);
    for (const [otherIndex, item] of previousDraft.entries()) {
      for (const message of conflictReasons(candidate, item, availability.restMinutes * MINUTE)) {
        addIssue(index, message);
        addIssue(otherIndex, message);
      }
    }
    previousDraft.push(candidate);
    const round = rounds.get(game.round);
    if (round) {
      round.start = Math.min(round.start, candidate.start);
      round.end = Math.max(round.end, candidate.end);
    } else
      rounds.set(game.round, { start: candidate.start, end: candidate.end });
  }
  let lastEnd = -Infinity;
  for (const [roundNumber, round] of [...rounds].sort(([a], [b]) => a - b)) {
    if (round.start < lastEnd) {
      const message = 'Round sequence conflict: a later round starts before an earlier round ends';
      for (const [index, game] of games.entries()) {
        if (game.round !== roundNumber) continue;
        for (const [otherIndex, other] of games.entries()) {
          if (other.round < roundNumber && previousDraft[index].start < previousDraft[otherIndex].end) {
            addIssue(index, message);
            addIssue(otherIndex, message);
          }
        }
      }
    }
    lastEnd = Math.max(lastEnd, round.end);
  }
  return issues;
}
