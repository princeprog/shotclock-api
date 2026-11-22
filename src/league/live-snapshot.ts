import { NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/db';
import { labelPending } from './bracket';

type Database = Kysely<DB> | Transaction<DB>;
type PlayerLine = { rosterId: string; name: string; jersey: number | null; points: number; rebounds: number; assists: number; steals: number; blocks: number; turnovers: number; fouls: number };
type Event = { id: string; sequence: number; kind: string; points: number | null; season_team_id: string | null; roster_id: string | null; period: number; clock_ms: number | null; voided_at: Date | null };

// Time left on a live game's clock; a running clock counts down from when it was started.
export function remaining(state: { clock_remaining_ms: number; clock_running_since: Date | null }, now = Date.now()) {
  return state.clock_running_since ? Math.max(0, state.clock_remaining_ms - (now - new Date(state.clock_running_since).getTime())) : state.clock_remaining_ms;
}

// Everything a console or viewer needs: score, clock, team fouls and timeouts, player lines and recent plays.
export async function liveSnapshot(db: Database, gameId: string, includeScorer = true) {
  const [rows, state, events] = await Promise.all([
    db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id').innerJoin('league.leagues as l', 'l.id', 's.league_id').innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .leftJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').leftJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .leftJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').leftJoin('league.teams as at', 'at.id', 'a.team_id').leftJoin('league.venues as v', 'v.id', 'g.venue_id')
      .selectAll('g').select((eb) => eb.selectFrom('league.player_game_stats as pgs').select('pgs.roster_id').whereRef('pgs.game_id', '=', 'g.id').where('pgs.best_player', '=', true).as('best_roster_id'))
      .select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name', 'd.name as division_name', 's.name as season_name', 's.status as season_status', 'l.name as league_name', 'l.time_zone',
        'l.period_count', 'l.period_minutes', 'l.overtime_minutes', 'l.bonus_fouls'])
      .where('g.id', '=', gameId).execute().then((found) => labelPending(db, found)),
    db.selectFrom('league.game_live_states as ls').leftJoin('auth.users as u', 'u.id', 'ls.scorer_user_id').selectAll('ls').select(['u.name as scorer_name', 'u.email as scorer_email']).where('ls.game_id', '=', gameId).executeTakeFirst(),
    db.selectFrom('league.game_events').select(['id', 'sequence', 'kind', 'points', 'season_team_id', 'roster_id', 'period', 'clock_ms', 'voided_at']).where('game_id', '=', gameId).orderBy('sequence').execute() as Promise<Event[]>,
  ]);
  const game = rows[0];
  if (!game) throw new NotFoundException();
  const teamIds = [game.home_season_team_id, game.away_season_team_id].filter((id): id is string => !!id);
  const rosters = teamIds.length ? await db.selectFrom('league.rosters as r').innerJoin('league.players as p', 'p.id', 'r.player_id')
    .select(['r.id', 'r.season_team_id', 'r.jersey_number', 'p.first_name', 'p.last_name']).where('r.season_team_id', 'in', teamIds)
    .orderBy('r.jersey_number').orderBy('p.last_name').orderBy('p.first_name').execute() : [];
  const counted = events.filter((event) => !event.voided_at);
  const period = state?.period ?? 1;
  const format = state ?? game;
  const side = (teamId: string | null, name: string) => {
    const teamEvents = counted.filter((event) => event.season_team_id === teamId);
    const players: PlayerLine[] = rosters.filter((roster) => roster.season_team_id === teamId).map((roster) => {
      const own = teamEvents.filter((event) => event.roster_id === roster.id);
      const count = (kind: string) => own.filter((event) => event.kind === kind).length;
      return { rosterId: roster.id, name: `${roster.first_name} ${roster.last_name}`, jersey: roster.jersey_number,
        points: own.reduce((sum, event) => sum + (event.points ?? 0), 0), rebounds: count('rebound'), assists: count('assist'), steals: count('steal'), blocks: count('block'), turnovers: count('turnover'), fouls: count('foul') };
    });
    return { seasonTeamId: teamId, name, score: teamEvents.reduce((sum, event) => sum + (event.points ?? 0), 0),
      teamFouls: teamEvents.filter((event) => event.kind === 'foul' && event.period === period).length,
      timeouts: teamEvents.filter((event) => event.kind === 'timeout').length, players };
  };
  const home = side(game.home_season_team_id, game.home_name);
  const away = side(game.away_season_team_id, game.away_name);
  // Points per period for the line score, through the regulation periods and any overtime played.
  const periodScores = Array.from({ length: state ? Math.max(period, format.period_count) : 0 }, (_, index) => ({ period: index + 1, home: 0, away: 0 }));
  for (const event of counted) {
    const line = periodScores[event.period - 1];
    if (!line || !event.points) continue;
    if (event.season_team_id === game.home_season_team_id) line.home += event.points;
    else if (event.season_team_id === game.away_season_team_id) line.away += event.points;
  }
  const names = new Map(rosters.map((roster) => [roster.id, `${roster.first_name} ${roster.last_name}`]));
  const bestSide = [home, away].find((side) => side.players.some((player) => player.rosterId === game.best_roster_id));
  const best = bestSide?.players.find((player) => player.rosterId === game.best_roster_id);
  const now = Date.now();
  return {
    gameId: game.id, status: game.status, version: state?.version ?? 0, stage: game.stage, scheduledAt: game.scheduled_at,
    leagueName: game.league_name, seasonName: game.season_name, divisionName: game.division_name, venueName: game.venue_name, timeZone: game.time_zone, seasonStatus: game.season_status,
    format: { periodCount: format.period_count, periodMinutes: format.period_minutes, overtimeMinutes: format.overtime_minutes, bonusFouls: format.bonus_fouls },
    period, clock: state ? { remainingMs: remaining(state, now), running: !!state.clock_running_since, serverTime: new Date(now).toISOString() } : null,
    home: { ...home, inBonus: away.teamFouls >= format.bonus_fouls }, away: { ...away, inBonus: home.teamFouls >= format.bonus_fouls },
    periodScores,
    finalScore: game.status === 'completed' ? { home: game.home_score, away: game.away_score } : null,
    bestPlayer: bestSide && best ? { ...best, seasonTeamId: bestSide.seasonTeamId, teamName: bestSide.name } : null,
    plays: events.slice(-30).reverse().map((event) => ({ id: event.id, sequence: event.sequence, kind: event.kind, points: event.points, seasonTeamId: event.season_team_id, rosterId: event.roster_id,
      player: event.roster_id ? names.get(event.roster_id) ?? null : null, period: event.period, clockMs: event.clock_ms, voided: !!event.voided_at })),
    scorer: includeScorer && state?.scorer_device_id ? { deviceId: state.scorer_device_id, name: state.scorer_name?.trim() || state.scorer_email } : null,
    live: !!state, startedAt: state?.started_at ?? null, finishedAt: state?.finished_at ?? null,
  };
}
