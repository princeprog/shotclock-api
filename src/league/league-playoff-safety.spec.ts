import { BadRequestException } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { LeagueService } from './league.service';

type Game = {
  id: string; season_id: string; division_id: string; stage: string; status: string;
  schedule_id: string | null; home_season_team_id: string; away_season_team_id: string;
  home_score: number | null; away_score: number | null;
};

const match = (id: string, home: string, away: string, stage = 'preliminary', homeScore: number | null = 10, awayScore: number | null = 0): Game => ({
  id, season_id: 'season', division_id: 'division', stage, status: homeScore === null ? 'scheduled' : 'completed',
  schedule_id: stage === 'preliminary' ? null : 'schedule', home_season_team_id: home,
  away_season_team_id: away, home_score: homeScore, away_score: awayScore,
});

describe('generated schedule registration safeguards', () => {
  const schedule = (division: string) => ({ id: 'schedule', division_id: division, playoffs: true, third_place: false });
  const error = 'Team registrations cannot change after a schedule has been generated for the division';

  it('rejects registration into a scheduled division after locking the season', async () => {
    const { state, service, db } = setup();
    state.schedules.push(schedule('division'));
    await expect(service.registerTeam('owner', 'season', 'team', 'division')).rejects.toThrow(error);
    const seasonLock = state.queries.findIndex((query) => query.text.includes('for update'));
    const scheduleCheck = state.queries.findIndex((query) => query.text.includes('from "league"."division_schedules"'));
    expect(seasonLock).toBeGreaterThanOrEqual(0);
    expect(scheduleCheck).toBeGreaterThan(seasonLock);
    expect(state.queries.some((query) => query.text.startsWith('insert into "league"."season_teams"'))).toBe(false);
    await db.destroy();
  });

  it('rejects team creation if any selected division has a schedule, before inserting the team', async () => {
    const { state, service, db } = setup();
    state.schedules.push(schedule('other'));
    await expect(service.createTeam('owner', 'league', { name: 'New', seasonId: 'season', divisionIds: ['division', 'other'] })).rejects.toThrow(error);
    expect(state.queries.some((query) => query.text.startsWith('insert into "league"."teams"'))).toBe(false);
    await db.destroy();
  });

  it.each([['division', 'other'], ['other', 'division']])('rejects moving from %s to %s when either division is scheduled', async (source, target) => {
    const { state, service, db } = setup();
    state.seasonStatus = 'draft';
    state.games = [];
    state.registration.division_id = source;
    state.schedules.push(schedule('division'));
    await expect(service.moveTeamRegistration('owner', 'registration', target)).rejects.toThrow(error);
    expect(state.queries.some((query) => query.text.startsWith('update "league"."season_teams"'))).toBe(false);
    await db.destroy();
  });

  it('rejects removal from a scheduled division even if no game references the registration', async () => {
    const { state, service, db } = setup();
    state.seasonStatus = 'draft';
    state.games = [];
    state.schedules.push(schedule('division'));
    await expect(service.removeTeamRegistration('owner', 'registration')).rejects.toThrow(error);
    await db.destroy();
  });

  it('permits a no-op move and changes in unscheduled divisions', async () => {
    const { state, service, db } = setup();
    state.seasonStatus = 'draft';
    state.games = [];
    state.schedules.push(schedule('division'));
    await expect(service.moveTeamRegistration('owner', 'registration', 'division')).resolves.toMatchObject({ division_id: 'division' });
    await expect(service.registerTeam('owner', 'season', 'team', 'other')).resolves.toMatchObject({ id: 'new-registration' });
    state.schedules = [];
    await expect(service.moveTeamRegistration('owner', 'registration', 'other')).resolves.toMatchObject({ division_id: 'other' });
    await expect(service.createTeam('owner', 'league', { name: 'New', seasonId: 'season', divisionId: 'division' })).resolves.toMatchObject({ id: 'new-team' });
    await db.destroy();
  });
});

// Use the real Kysely PostgreSQL compiler with an in-memory query boundary.
function setup() {
  const state = {
    games: [match('ab', 'a', 'b'), match('ac', 'a', 'c'), match('ad', 'a', 'd'),
      match('bc', 'b', 'c'), match('bd', 'b', 'd'), match('cd', 'c', 'd')],
    teams: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, division_id: 'division' })),
    schedules: [] as { id: string; division_id: string; playoffs: boolean; third_place: boolean }[],
    seasonStatus: 'active',
    divisions: ['division', 'other'].map((id) => ({ id, name: id, season_id: 'season', min_age: null, max_age: null })),
    registration: { id: 'registration', season_id: 'season', division_id: 'division' },
    queries: [] as { text: string; values: readonly unknown[] }[],
  };
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      state.queries.push({ text, values });
      let rows: object[] = [];
      const condition = (column: string) => {
        const found = text.match(new RegExp(`(?:"[a-z]+"\\.)?"${column}" = \\$(\\d+)`));
        return found ? values[Number(found[1]) - 1] : undefined;
      };
      if (text.includes('from "league"."seasons"')) rows = [{ id: 'season', league_id: 'league', status: state.seasonStatus, start_date: null }];
      else if (text.includes('from "league"."leagues"')) rows = [{ id: 'league' }];
      else if (text.includes('from "league"."teams"')) rows = [{ id: 'team', league_id: 'league' }];
      else if (text.includes('from "league"."divisions"')) rows = state.divisions.filter((division) => condition('id') === undefined || division.id === condition('id'));
      else if (text.includes('from "league"."division_schedules"')) rows = state.schedules.filter((schedule) =>
        (condition('playoffs') === undefined || schedule.playoffs === condition('playoffs')) &&
        (condition('division_id') === undefined || schedule.division_id === condition('division_id')));
      else if (text.includes('from "league"."season_teams"')) {
        if (condition('id') === 'registration') rows = [state.registration];
        else rows = text.includes('"id" in') ? state.teams.filter((team) => values.includes(team.id)) : state.teams;
      }
      else if (text.includes('from "league"."games"')) {
        rows = state.games.filter((game) => {
          for (const key of ['id', 'season_id', 'division_id', 'stage', 'status', 'schedule_id'] as const) {
            const expected = condition(key);
            if (expected !== undefined && game[key] !== expected) return false;
          }
          if (text.includes('"stage" in')) {
            const stages = values.filter((value) => ['semifinal', 'final', 'third_place'].includes(String(value)));
            if (!stages.includes(game.stage)) return false;
          }
          if (text.includes('"home_score" is not null') && game.home_score === null) return false;
          if (text.includes('"away_score" is not null') && game.away_score === null) return false;
          return true;
        });
      } else if (text.includes('from "league"."rosters"')) rows = [];
      else if (text.startsWith('insert into "league"."teams"')) rows = [{ id: 'new-team', name: 'New' }];
      else if (text.startsWith('insert into "league"."season_teams"')) rows = [{ id: 'new-registration' }];
      else if (text.startsWith('update "league"."season_teams"')) rows = [{ ...state.registration, division_id: values[0] }];
      else if (text.startsWith('update "league"."games"')) {
        const game = state.games.find((item) => item.id === condition('id'))!;
        for (const [, field, index] of text.matchAll(/"(home_score|away_score|status|home_season_team_id|away_season_team_id)" = \$(\d+)/g)) {
          Object.assign(game, { [field]: values[Number(index) - 1] });
        }
        rows = [game];
      } else if (text.startsWith('update "league"."seasons"')) rows = [{ id: 'season', status: 'completed' }];
      else if (text.startsWith('insert into "league"."games"')) rows = [{ id: 'created' }];
      return { command: text.split(' ')[0].toUpperCase(), rowCount: rows.length, rows };
    },
    release() {},
  };
  const pool = { connect: async () => client, end: async () => {} } as unknown as Pool;
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const service = new LeagueService({ db } as DatabaseService);
  return { state, service, db };
}

describe('league playoff safeguards', () => {
  it('excludes completed playoff games from standings', async () => {
    const { state, service, db } = setup();
    state.games.push(match('final', 'd', 'a', 'final', 100, 0));
    const rows = await service.standings('owner', 'season', 'division');
    expect(rows.map((row) => [row.id, row.wins])).toEqual([['a', 3], ['b', 2], ['c', 1], ['d', 0]]);
    await db.destroy();
  });

  it('requires a final and configured third-place game before completing a season', async () => {
    const { state, service, db } = setup();
    state.schedules.push({ id: 'schedule', division_id: 'division', playoffs: true, third_place: true });
    await expect(service.transition('owner', 'season', 'completed')).rejects.toThrow(BadRequestException);
    state.games.push(match('final', 'a', 'b', 'final'));
    await expect(service.transition('owner', 'season', 'completed')).rejects.toThrow(BadRequestException);
    state.games.push(match('third', 'c', 'd', 'third_place'));
    await expect(service.transition('owner', 'season', 'completed')).resolves.toMatchObject({ status: 'completed' });
    await db.destroy();
  });

  it('does not require third place when it is not configured or any final when playoffs are disabled', async () => {
    const { state, service, db } = setup();
    state.schedules.push({ id: 'schedule', division_id: 'division', playoffs: true, third_place: false });
    state.games.push(match('final', 'a', 'b', 'final'));
    await expect(service.transition('owner', 'season', 'completed')).resolves.toMatchObject({ status: 'completed' });
    state.games.pop();
    state.schedules[0].playoffs = false;
    await expect(service.transition('owner', 'season', 'completed')).resolves.toMatchObject({ status: 'completed' });
    await db.destroy();
  });

  it('does not accept a final from a different schedule as the required final', async () => {
    const { state, service, db } = setup();
    state.schedules.push({ id: 'schedule', division_id: 'division', playoffs: true, third_place: false });
    state.games.push({ ...match('other-final', 'a', 'b', 'final'), schedule_id: 'other-schedule' });
    await expect(service.transition('owner', 'season', 'completed')).rejects.toThrow(BadRequestException);
    state.games.push(match('final', 'a', 'b', 'final', null, null));
    await expect(service.transition('owner', 'season', 'completed')).rejects.toThrow(BadRequestException);
    await db.destroy();
  });

  it('allows a harmless preliminary correction but rejects one changing semifinal pairings', async () => {
    const { state, service, db } = setup();
    state.games.push(match('sf1', 'a', 'd', 'semifinal', null, null), match('sf2', 'b', 'c', 'semifinal', null, null));
    await expect(service.score('owner', 'ab', { homeScore: 12, awayScore: 0 })).resolves.toMatchObject({ id: 'ab' });
    await expect(service.score('owner', 'ab', { homeScore: 0, awayScore: 12 })).rejects.toThrow(BadRequestException);
    await db.destroy();
  });

  it('permits changed seeding when the semifinal pairings remain the same', async () => {
    const { state, service, db } = setup();
    state.games.push(match('sf1', 'a', 'd', 'semifinal', null, null), match('sf2', 'b', 'c', 'semifinal', null, null));
    await expect(service.score('owner', 'bc', { homeScore: 0, awayScore: 12 })).resolves.toMatchObject({ id: 'bc', home_score: 0, away_score: 12 });
    await db.destroy();
  });

  it('allows a harmless semifinal correction but rejects changing its winner once a final or third-place game exists', async () => {
    for (const stage of ['final', 'third_place']) {
      const { state, service, db } = setup();
      state.games.push(match('sf1', 'a', 'd', 'semifinal'), match('next', 'a', 'b', stage, null, null));
      await expect(service.score('owner', 'sf1', { homeScore: 11, awayScore: 0 })).resolves.toMatchObject({ id: 'sf1' });
      await expect(service.score('owner', 'sf1', { homeScore: 0, awayScore: 11 })).rejects.toThrow(BadRequestException);
      await db.destroy();
    }
  });

  it('allows changing a semifinal winner before downstream games exist', async () => {
    const { state, service, db } = setup();
    state.games.push(match('sf1', 'a', 'd', 'semifinal'));
    await expect(service.score('owner', 'sf1', { homeScore: 0, awayScore: 11 })).resolves.toMatchObject({ home_score: 0, away_score: 11 });
    await db.destroy();
  });

  it('prevents generated game participant changes and takes the league scheduling lock after the season lock', async () => {
    const { state, service, db } = setup();
    state.games.push(match('sf1', 'a', 'd', 'semifinal', null, null));
    const dto = { homeTeamId: 'b', awayTeamId: 'd', scheduledAt: '2026-11-10T10:00:00Z' };
    await expect(service.editGame('owner', 'sf1', dto)).rejects.toThrow(BadRequestException);
    const seasonLock = state.queries.findIndex((query) => query.text.includes('for update'));
    const leagueLock = state.queries.findIndex((query) => query.text.includes('pg_advisory_xact_lock') && query.values.includes('league'));
    expect(seasonLock).toBeGreaterThanOrEqual(0);
    expect(leagueLock).toBeGreaterThan(seasonLock);
    expect(state.queries[leagueLock].text).toContain('shotclock:schedule:league:');
    await db.destroy();
  });

  it('allows rescheduling generated games with the same participants', async () => {
    const { state, service, db } = setup();
    state.games.push(match('sf1', 'a', 'd', 'semifinal', null, null));
    await expect(service.editGame('owner', 'sf1', { homeTeamId: 'd', awayTeamId: 'a', scheduledAt: '2026-11-10T10:00:00Z' }))
      .rejects.toThrow(BadRequestException);
    await expect(service.editGame('owner', 'sf1', { homeTeamId: 'a', awayTeamId: 'd', scheduledAt: '2026-11-10T10:00:00Z' }))
      .resolves.toMatchObject({ id: 'sf1', home_season_team_id: 'a', away_season_team_id: 'd' });
    await db.destroy();
  });

  it('takes the same league scheduling lock for manual game creation', async () => {
    const { state, service, db } = setup();
    await service.createGame('owner', 'season', { homeTeamId: 'a', awayTeamId: 'b', scheduledAt: '2026-11-10T10:00:00Z' });
    const seasonLock = state.queries.findIndex((query) => query.text.includes('for update'));
    const leagueLock = state.queries.findIndex((query) => query.text.includes('pg_advisory_xact_lock') && query.values.includes('league'));
    const insert = state.queries.findIndex((query) => query.text.startsWith('insert into "league"."games"'));
    expect(seasonLock).toBeGreaterThanOrEqual(0);
    expect(leagueLock).toBeGreaterThan(seasonLock);
    expect(insert).toBeGreaterThan(leagueLock);
    expect(state.queries[leagueLock].text).toContain('shotclock:schedule:league:');
    await db.destroy();
  });
});
