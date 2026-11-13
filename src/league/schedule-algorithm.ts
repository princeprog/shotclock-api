export type SchedulePace = 'weekly' | 'spread' | 'compact';

export type ScheduleAvailability = {
  startDate: string;
  endDate: string;
  windows: { weekdays: number[]; startTime: string; endTime: string }[];
  timeZone: string;
  venueIds: string[];
  durationMinutes: number;
  restMinutes: number;
  blackoutDates?: string[];
  pace?: SchedulePace;
  maxGamesPerTeamPerDay?: number;
  changeoverMinutes?: number;
  teamUnavailability?: { teamId: string; dates: string[] }[];
};

export type ScheduleMatch = {
  homeTeamId: string;
  awayTeamId: string;
  round: number;
  stage: 'preliminary' | 'semifinal' | 'final' | 'third_place';
  groupId?: string;
};

export type ScheduleGame = ScheduleMatch & {
  scheduledAt: string;
  venueId: string;
  durationMinutes: number;
};

export type ExistingGame = {
  id?: string;
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
  id?: string;
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
  pace: SchedulePace;
  maxPerDay: number;
  changeover: number;
  length: number;
  venueIds: string[];
  unavailable: Map<string, Set<string>>;
  weekOf: (date: string) => number;
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
  const pace = availability.pace ?? 'compact';
  if (!['weekly', 'spread', 'compact'].includes(pace)) throw new Error('Invalid pace');
  if (availability.maxGamesPerTeamPerDay !== undefined) duration(availability.maxGamesPerTeamPerDay, 'maxGamesPerTeamPerDay', 1, 10);
  if (availability.changeoverMinutes !== undefined) duration(availability.changeoverMinutes, 'changeoverMinutes', 0, 240);
  const unavailable = new Map<string, Set<string>>();
  if (availability.teamUnavailability !== undefined) {
    if (!Array.isArray(availability.teamUnavailability) || availability.teamUnavailability.length > 200) throw new Error('Invalid teamUnavailability: expected at most 200 teams');
    for (const entry of availability.teamUnavailability) {
      if (!entry || !id(entry.teamId) || unavailable.has(entry.teamId)) throw new Error('Invalid teamUnavailability: teams must be unique');
      unavailable.set(entry.teamId, dateSet(entry.dates, 'teamUnavailability'));
    }
  }
  return { start, end, weeklyWindows, formatter, blackouts, pace, unavailable,
    maxPerDay: availability.maxGamesPerTeamPerDay ?? Infinity,
    changeover: (availability.changeoverMinutes ?? 0) * MINUTE,
    length: availability.durationMinutes * MINUTE,
    venueIds: availability.venueIds,
    weekOf: (value: string) => Math.floor((Date.parse(`${value}T00:00:00Z`) - start) / (7 * DAY)) };
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
      id: game.id,
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
  const config = settings(availability);
  const intervals = windows(config);
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
  // A changeover is needed between games, so n games use n durations plus n - 1 changeovers.
  const slots = (gap: number) => Math.floor(Math.max(0, gap + config.changeover) / (config.length + config.changeover));
  let total = 0;
  for (const venueId of availability.venueIds) {
    const blocked = busy.filter((game) => game.venueId === venueId).sort((a, b) => a.start - b.start);
    for (const interval of intervals) {
      let cursor = interval.start;
      for (const item of blocked) {
        if (item.end <= cursor) continue;
        if (item.start >= interval.end) break;
        total += slots(item.start - cursor);
        cursor = Math.max(cursor, item.end);
        if (cursor >= interval.end) break;
      }
      total += slots(interval.end - cursor);
    }
  }
  return total;
}

type Config = ReturnType<typeof settings>;
type PlayInterval = Interval & { date: string; week: number; day: number };
type PlacementOptions = { checkTeams: boolean; checkVenues: boolean; checkDays: boolean; rest: number; earliest: number; latest: number; minDay: number; fair?: boolean };

function playIntervals(config: Config): PlayInterval[] {
  const intervals = windows(config).map((interval) => ({ ...interval, date: localParts(config.formatter, interval.start).date }));
  const days = new Map([...new Set(intervals.map((interval) => interval.date))].sort().map((value, index) => [value, index]));
  return intervals.map((interval) => ({ ...interval, week: config.weekOf(interval.date), day: days.get(interval.date)! }));
}

function involves(game: { homeTeamId: string; awayTeamId: string }, team: string): boolean {
  return game.homeTeamId === team || game.awayTeamId === team;
}

// Tracks booked games and the per-team counts that the day, week and round rules read.
class PlacementState {
  readonly busy: BusyGame[] = [];
  private readonly days = new Map<string, number>();
  private readonly weeks = new Map<string, number>();
  private readonly rounds = new Map<string, { round: number; start: number; end: number }[]>();
  private readonly tipOffs = new Map<string, number>();
  private readonly venues = new Map<string, number>();

  constructor(private readonly config: Config) {}

  add(game: BusyGame, round?: number): void {
    this.busy.push(game);
    const { date, minutes } = localParts(this.config.formatter, game.start);
    const week = this.config.weekOf(date);
    for (const team of [game.homeTeamId, game.awayTeamId]) {
      this.days.set(`${team}\u0000${date}`, (this.days.get(`${team}\u0000${date}`) ?? 0) + 1);
      this.weeks.set(`${team}\u0000${week}`, (this.weeks.get(`${team}\u0000${week}`) ?? 0) + 1);
      if (round === undefined) continue;
      this.rounds.set(team, [...(this.rounds.get(team) ?? []), { round, start: game.start, end: game.end }]);
      this.tipOffs.set(`${team}\u0000${minutes}`, (this.tipOffs.get(`${team}\u0000${minutes}`) ?? 0) + 1);
      this.venues.set(`${team}\u0000${game.venueId}`, (this.venues.get(`${team}\u0000${game.venueId}`) ?? 0) + 1);
    }
  }

  // Lower is fairer: repeating a team's tip-off time costs twice as much as repeating its venue.
  score(teams: string[], start: number, venueId: string): number {
    const { minutes } = localParts(this.config.formatter, start);
    return teams.reduce((total, team) => total + 2 * (this.tipOffs.get(`${team}\u0000${minutes}`) ?? 0) + (this.venues.get(`${team}\u0000${venueId}`) ?? 0), 0);
  }

  allows(teams: string[], date: string, week: number): boolean {
    return teams.every((team) => !this.config.unavailable.get(team)?.has(date) &&
      (this.days.get(`${team}\u0000${date}`) ?? 0) < this.config.maxPerDay &&
      (this.config.pace !== 'weekly' || (this.weeks.get(`${team}\u0000${week}`) ?? 0) < 1));
  }

  // A team plays its rounds in order: after its earlier-round games end and before its later-round games start.
  bounds(match: ScheduleMatch): { earliest: number; latest: number } {
    let earliest = -Infinity;
    let latest = Infinity;
    for (const team of [match.homeTeamId, match.awayTeamId]) {
      for (const game of this.rounds.get(team) ?? []) {
        if (game.round < match.round) earliest = Math.max(earliest, game.end);
        if (game.round > match.round) latest = Math.min(latest, game.start);
      }
    }
    return { earliest, latest };
  }
}

function firstFit(blocked: Interval[], from: number, to: number, length: number): number | undefined {
  let start = from;
  for (const item of blocked) {
    if (item.end <= start) continue;
    if (item.start >= start + length) break;
    start = Math.ceil(item.end / MINUTE) * MINUTE;
  }
  return start + length <= to ? start : undefined;
}

function conflictReasons(
  candidate: BusyGame,
  previous: BusyGame,
  rest: number,
  changeover: number,
): string[] {
  const reasons: string[] = [];
  const sameTeam =
    involves(previous, candidate.homeTeamId) || involves(previous, candidate.awayTeamId);
  if (
    sameTeam &&
    candidate.start < previous.end + rest &&
    previous.start < candidate.end + rest
  )
    reasons.push('Team conflict: a team is playing or has insufficient rest. Choose another time.');
  if (
    candidate.venueId !== null &&
    candidate.venueId === previous.venueId &&
    candidate.start < previous.end + changeover &&
    previous.start < candidate.end + changeover
  ) reasons.push(candidate.start < previous.end && previous.start < candidate.end
    ? 'Venue conflict: this court is already booked. Choose another time or venue.'
    : 'Venue conflict: this court needs changeover time between games. Choose another time or venue.');
  return reasons;
}

function findPlacement(
  match: ScheduleMatch,
  config: Config,
  intervals: PlayInterval[],
  state: PlacementState,
  options: PlacementOptions,
): BusyGame | undefined {
  const teams = [match.homeTeamId, match.awayTeamId];
  const teamBlocked = options.checkTeams
    ? state.busy.filter((item) => teams.some((team) => involves(item, team))).map((item) => ({ start: item.start - options.rest, end: item.end + options.rest }))
    : [];
  const earliest = Math.ceil(options.earliest / MINUTE) * MINUTE;
  let selected: BusyGame | undefined;
  const blockedByVenue = config.venueIds.map((venueId) => [...teamBlocked, ...(options.checkVenues
    ? state.busy.filter((item) => item.venueId === venueId).map((item) => ({ start: item.start - config.changeover, end: item.end + config.changeover }))
    : [])].sort((a, b) => a.start - b.start));
  for (const [venueIndex, venueId] of config.venueIds.entries()) {
    const blocked = blockedByVenue[venueIndex];
    for (const interval of intervals) {
      if (selected && interval.start >= selected.start) break;
      if (interval.end <= earliest || interval.day < options.minDay) continue;
      if (options.checkDays && !state.allows(teams, interval.date, interval.week)) continue;
      const start = firstFit(blocked, Math.max(interval.start, earliest), Math.min(interval.end, options.latest), config.length);
      if (start === undefined) continue;
      if (!selected || start < selected.start) selected = { ...match, venueId, start, end: start + config.length };
      break;
    }
  }
  if (!selected || !options.fair) return selected;
  // On the earliest playable day, prefer the slot that evens out each team's tip-off times and venues.
  const day = localParts(config.formatter, selected.start).date;
  let best = { game: selected, score: state.score(teams, selected.start, selected.venueId!) };
  for (const [venueIndex, venueId] of config.venueIds.entries()) {
    for (const interval of intervals) {
      if (interval.date !== day || interval.end <= earliest) continue;
      const to = Math.min(interval.end, options.latest);
      let from = Math.max(interval.start, earliest);
      for (let start = firstFit(blockedByVenue[venueIndex], from, to, config.length); start !== undefined; start = firstFit(blockedByVenue[venueIndex], from, to, config.length)) {
        const score = state.score(teams, start, venueId);
        if (score < best.score || (score === best.score && start < best.game.start)) best = { game: { ...match, venueId, start, end: start + config.length }, score };
        from = start + config.length + config.changeover;
      }
    }
  }
  return best.game;
}

function placementReason(
  match: ScheduleMatch,
  total: number,
  availability: ScheduleAvailability,
  config: Config,
  intervals: PlayInterval[],
  state: PlacementState,
  options: PlacementOptions,
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
  const capacity = intervals.reduce((count, interval) => count + Math.floor((interval.end - interval.start + config.changeover) / (config.length + config.changeover)), 0) * availability.venueIds.length;
  if (capacity < total) {
    const shortfall = total - capacity;
    return `The selected windows and venues can fit at most ${capacity} ${capacity === 1 ? 'game' : 'games'}, but ${total} games are needed, even before conflicts and rest are considered. Add at least ${shortfall} more game ${shortfall === 1 ? 'slot' : 'slots'} by extending playing time or adding venues.`;
  }
  const fits = (changes: Partial<PlacementOptions>) => !!findPlacement(match, config, intervals, state, { ...options, ...changes });
  if (options.rest && fits({ rest: 0 })) {
    return `In this attempted schedule, the minimum rest of ${availability.restMinutes} minutes leaves no available slot for this matchup. Add playing time or reduce the rest requirement. A different arrangement may also work.`;
  }
  const dayRules = config.unavailable.size > 0 || Number.isFinite(config.maxPerDay) || config.pace === 'weekly';
  if (dayRules && fits({ checkDays: false })) {
    return 'In this attempted schedule, the games-per-day limit, weekly pacing or team unavailable dates leave no slot for this matchup. Extend the date range, add playing days or relax these limits. A different arrangement may also work.';
  }
  if ((Number.isFinite(options.earliest) || Number.isFinite(options.latest)) && fits({ earliest: -Infinity, latest: Infinity })) {
    return 'A suitable slot exists earlier, but each team must finish its previous round first. Add more playing time or extend the date range. A different arrangement may also work.';
  }
  if (options.minDay > 0 && fits({ minDay: 0 })) {
    return 'Spread pacing reserves later dates for this round, and those dates are full. Add playing time or choose weekly pacing. A different arrangement may also work.';
  }
  if (fits({ checkTeams: false })) {
    return 'In this attempted schedule, one or both teams are already playing or resting whenever a suitable slot is available. Add playing time or adjust the rest requirement. A different arrangement may also work.';
  }
  if (fits({ checkVenues: false })) {
    return 'In this attempted schedule, the selected venues are occupied when this matchup could otherwise play. Add a venue or more playing time. A different arrangement may also work.';
  }
  return 'The selected times, venues, team availability, rest and round order leave no slot in this attempt. Add playing time or venues, or reduce rest. A different arrangement may also work.';
}

type Unplaced = { index: number; match: ScheduleMatch; placed: number; reason: string };

type Placement = { games: (ScheduleGame | undefined)[]; unplaced: Unplaced[] };

function place(
  matches: ScheduleMatch[],
  availability: ScheduleAvailability,
  existing: ExistingGame[],
  stopAtFirst: boolean,
): Placement {
  const config = settings(availability);
  if (!Array.isArray(matches) || matches.length > MAX_GAMES)
    throw new Error('Invalid matches (maximum 10000)');
  matches.forEach(validateMatch);
  const busy = busyGames(existing, availability);
  if (!matches.length) return { games: [], unplaced: [] };
  if (
    matches.length *
      (busy.length + matches.length) *
      availability.venueIds.length >
    MAX_COMPARISONS
  )
    throw new Error('Scheduling input exceeds work limit');
  const intervals = playIntervals(config);
  const fair = attempt(matches, availability, config, intervals, busy, stopAtFirst, config.pace !== 'compact');
  if (!fair.unplaced.length || config.pace === 'compact') return fair;
  // Balancing can take a slot a later game needed; retry with earliest slots and keep the better attempt.
  const earliest = attempt(matches, availability, config, intervals, busy, stopAtFirst, false);
  return earliest.unplaced.length < fair.unplaced.length ? earliest : fair;
}

function attempt(
  matches: ScheduleMatch[],
  availability: ScheduleAvailability,
  config: Config,
  intervals: PlayInterval[],
  busy: BusyGame[],
  stopAtFirst: boolean,
  fair: boolean,
): Placement {
  const state = new PlacementState(config);
  for (const game of busy) state.add(game);
  const rest = availability.restMinutes * MINUTE;
  const ordered = matches
    .map((match, index) => ({ match, index }))
    .sort((a, b) => a.match.round - b.match.round || a.index - b.index);
  // Spread pacing gives round r of a group with R rounds the playing days from floor((r - 1) * days / R) onward.
  const playingDays = intervals.length ? intervals[intervals.length - 1].day + 1 : 0;
  const groupRounds = new Map<string, number>();
  for (const match of matches) groupRounds.set(match.groupId ?? '', Math.max(groupRounds.get(match.groupId ?? '') ?? 0, match.round));
  const games: (ScheduleGame | undefined)[] = new Array(matches.length);
  const unplaced: Unplaced[] = [];
  let placed = 0;
  for (const { match, index } of ordered) {
    const minDay = config.pace === 'spread' ? Math.floor((match.round - 1) * playingDays / groupRounds.get(match.groupId ?? '')!) : 0;
    const options: PlacementOptions = { checkTeams: true, checkVenues: true, checkDays: true, rest, minDay, fair, ...state.bounds(match) };
    const selected = findPlacement(match, config, intervals, state, options);
    if (!selected) {
      unplaced.push({ index, match, placed, reason: placementReason(match, matches.length, availability, config, intervals, state, { ...options, fair: false }) });
      if (stopAtFirst) break;
      continue;
    }
    state.add(selected, match.round);
    placed++;
    const { groupId: _groupId, ...fixture } = match;
    games[index] = {
      ...fixture,
      scheduledAt: new Date(selected.start).toISOString(),
      venueId: selected.venueId!,
      durationMinutes: availability.durationMinutes,
    };
  }
  return { games, unplaced };
}

export function scheduleMatches(
  matches: ScheduleMatch[],
  availability: ScheduleAvailability,
  existing: ExistingGame[],
): ScheduleGame[] {
  const { games, unplaced } = place(matches, availability, existing, true);
  if (unplaced.length) throw new SchedulePlacementError(unplaced[0].match, unplaced[0].placed, matches.length, unplaced[0].reason);
  return games as ScheduleGame[];
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
  const rest = availability.restMinutes * MINUTE;
  const issues: { index: number; message: string }[] = [];
  const issueKeys = new Set<string>();
  const drafts: (BusyGame & { round: number; date: string })[] = [];
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
    const candidate = {
      ...game,
      start,
      end: start + game.durationMinutes * MINUTE,
      date: localParts(config.formatter, start).date,
    };
    if (config.blackouts.has(candidate.date)) addIssue(index, 'Blackout date: games cannot be scheduled on this date. Choose another date.');
    else if (
      !intervals.some(
        (interval) =>
          candidate.start >= interval.start && candidate.end <= interval.end,
      )
    )
      addIssue(index, 'Game outside availability window');
    if ([game.homeTeamId, game.awayTeamId].some((team) => config.unavailable.get(team)?.has(candidate.date)))
      addIssue(index, 'Team availability: a team is unavailable on this date. Choose another date.');
    for (const item of busy) for (const message of conflictReasons(candidate, item, rest, config.changeover)) addIssue(index, message);
    for (const [otherIndex, item] of drafts.entries()) {
      for (const message of conflictReasons(candidate, item, rest, config.changeover)) {
        addIssue(index, message);
        addIssue(otherIndex, message);
      }
    }
    drafts.push(candidate);
  }
  const limitRules: { key: (team: string, date: string) => string; limit: number; message: string }[] = [];
  if (Number.isFinite(config.maxPerDay)) limitRules.push({ key: (team, date) => `${team}\u0000${date}`, limit: config.maxPerDay,
    message: `Daily limit: a team has more than ${config.maxPerDay} ${config.maxPerDay === 1 ? 'game' : 'games'} on this day. Choose another date.` });
  if (config.pace === 'weekly') limitRules.push({ key: (team, date) => `${team}\u0000${config.weekOf(date)}`, limit: 1,
    message: 'Weekly pacing: a team plays more than once this week. Choose another week.' });
  if (limitRules.length) {
    const existingDates = busy.map((item) => ({ item, date: localParts(config.formatter, item.start).date }));
    for (const rule of limitRules) {
      const counts = new Map<string, { total: number; indexes: number[] }>();
      const count = (team: string, date: string, index?: number) => {
        const entry = counts.get(rule.key(team, date)) ?? { total: 0, indexes: [] };
        entry.total++;
        if (index !== undefined) entry.indexes.push(index);
        counts.set(rule.key(team, date), entry);
      };
      for (const { item, date } of existingDates) for (const team of [item.homeTeamId, item.awayTeamId]) count(team, date);
      for (const [index, item] of drafts.entries()) for (const team of [item.homeTeamId, item.awayTeamId]) count(team, item.date, index);
      for (const entry of counts.values()) if (entry.total > rule.limit) for (const index of entry.indexes) addIssue(index, rule.message);
    }
  }
  const byTeam = new Map<string, number[]>();
  for (const [index, item] of drafts.entries()) for (const team of [item.homeTeamId, item.awayTeamId]) byTeam.set(team, [...(byTeam.get(team) ?? []), index]);
  for (const indexes of byTeam.values()) {
    for (const first of indexes) {
      for (const second of indexes) {
        const earlier = drafts[first];
        const later = drafts[second];
        if (earlier.round < later.round && later.start < earlier.end) {
          addIssue(first, 'Round sequence conflict: a later round starts before an earlier round ends');
          addIssue(second, 'Round sequence conflict: a later round starts before an earlier round ends');
        }
      }
    }
  }
  return issues;
}

