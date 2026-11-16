import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service';
import { calculateStandings } from '../league/standings';
import { statLeaders, teamForm, teamStats, winPct, type ResultGame, type StatTeam } from './team-stats';

// Read-only data for the public website. Only published leagues in unarchived organizations, and their
// active or completed unarchived seasons, are visible; everything else is a 404. No player or account data is returned.
const PUBLIC_SEASON_STATUSES = ['active', 'completed'];
const DIRECTORY_PAGE_SIZE = 12;

type LeagueRow = { id: string; slug: string | null; name: string; location: string | null; time_zone: string | null; organization: string };
type SeasonRow = { id: string; league_id: string; slug: string; name: string; status: string; start_date: string | null; end_date: string | null; created_at: Date };
type DivisionRow = { id: string; name: string; min_age: number | null; max_age: number | null; team_count: number };
type GameRow = {
  id: string; scheduled_at: Date | null; status: string; stage: string; round: number | null; duration_minutes: number | null;
  home_score: number | null; away_score: number | null; forfeited_by_season_team_id: string | null;
  home_id: string; home_team_id: string; home_name: string; home_abbreviation: string | null;
  away_id: string; away_team_id: string; away_name: string; away_abbreviation: string | null;
  venue_name: string | null; venue_address: string | null;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const leagueView = (league: LeagueRow) => ({ slug: league.slug!, name: league.name, location: league.location, timeZone: league.time_zone, organization: league.organization });
const seasonView = (season: SeasonRow) => ({ slug: season.slug, name: season.name, status: season.status, startDate: season.start_date, endDate: season.end_date });
const divisionView = (division: DivisionRow) => ({ id: division.id, name: division.name, minAge: division.min_age, maxAge: division.max_age, teamCount: Number(division.team_count) });

// Active seasons first, then the most recent by start date and creation.
export function sortSeasons<T extends Pick<SeasonRow, 'status' | 'start_date' | 'created_at'>>(seasons: T[]) {
  return [...seasons].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active')
    || (b.start_date ?? '').localeCompare(a.start_date ?? '')
    || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function gameView(row: GameRow) {
  return {
    id: row.id,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    status: row.status as 'scheduled' | 'completed',
    stage: row.stage,
    round: row.round,
    durationMinutes: row.duration_minutes,
    venue: row.venue_name ? { name: row.venue_name, address: row.venue_address } : null,
    home: { id: row.home_id, teamId: row.home_team_id, name: row.home_name, abbreviation: row.home_abbreviation, score: row.home_score },
    away: { id: row.away_id, teamId: row.away_team_id, name: row.away_name, abbreviation: row.away_abbreviation, score: row.away_score },
    forfeit: row.forfeited_by_season_team_id === null ? null : row.forfeited_by_season_team_id === row.home_id ? 'home' as const : 'away' as const,
  };
}

function resultGame(row: GameRow): ResultGame {
  return { id: row.id, homeId: row.home_id, awayId: row.away_id, homeScore: row.home_score!, awayScore: row.away_score!, forfeit: row.forfeited_by_season_team_id !== null, playedAt: row.scheduled_at ? new Date(row.scheduled_at).getTime() : 0 };
}

@Injectable()
export class PublicService {
  constructor(private readonly database: DatabaseService) {}
  private get db() { return this.database.db; }

  private leagues() {
    return this.db.selectFrom('league.leagues as l').innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['l.id', 'l.slug', 'l.name', 'l.location', 'l.time_zone', 'o.name as organization'])
      .where('l.published_at', 'is not', null).where('l.slug', 'is not', null)
      .where('l.archived_at', 'is', null).where('o.archived_at', 'is', null);
  }

  private async seasonsOf(leagueIds: string[]): Promise<SeasonRow[]> {
    if (!leagueIds.length) return [];
    return this.db.selectFrom('league.seasons')
      .select(['id', 'league_id', 'slug', 'name', 'status', 'created_at', sql<string | null>`start_date::text`.as('start_date'), sql<string | null>`end_date::text`.as('end_date')])
      .where('league_id', 'in', leagueIds).where('status', 'in', PUBLIC_SEASON_STATUSES).where('archived_at', 'is', null).execute();
  }

  async directory(search?: string, page = 1) {
    let query = this.leagues().where((eb) => eb.exists(eb.selectFrom('league.seasons as s').select('s.id')
      .whereRef('s.league_id', '=', 'l.id').where('s.status', 'in', PUBLIC_SEASON_STATUSES).where('s.archived_at', 'is', null)));
    const term = search?.trim();
    if (term) {
      const pattern = `%${escapeLike(term)}%`;
      query = query.where((eb) => eb.or([
        eb('l.name', 'ilike', pattern), eb('l.location', 'ilike', pattern), eb('o.name', 'ilike', pattern),
        eb.exists(eb.selectFrom('league.teams as t').select('t.id').whereRef('t.league_id', '=', 'l.id').where('t.name', 'ilike', pattern)),
      ]));
    }
    const { count } = await query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
    const total = Number(count);
    const leagues = await query
      .orderBy(sql`exists (select 1 from league.seasons s where s.league_id = l.id and s.status = 'active' and s.archived_at is null)`, 'desc')
      .orderBy('l.name').orderBy('l.id')
      .limit(DIRECTORY_PAGE_SIZE).offset((page - 1) * DIRECTORY_PAGE_SIZE).execute();
    const seasons = await this.seasonsOf(leagues.map((league) => league.id));
    const current = new Map(leagues.map((league) => [league.id, sortSeasons(seasons.filter((season) => season.league_id === league.id))[0]]));
    const seasonIds = [...current.values()].map((season) => season.id);
    const [teamCounts, divisionCounts] = seasonIds.length ? await Promise.all([
      this.db.selectFrom('league.season_teams').select(['season_id', sql<string>`count(distinct team_id)`.as('count')]).where('season_id', 'in', seasonIds).groupBy('season_id').execute(),
      this.db.selectFrom('league.divisions').select(['season_id', sql<string>`count(*)`.as('count')]).where('season_id', 'in', seasonIds).groupBy('season_id').execute(),
    ]) : [[], []];
    const countFor = (rows: { season_id: string; count: string }[], id: string) => Number(rows.find((row) => row.season_id === id)?.count ?? 0);
    return {
      items: leagues.map((league) => {
        const season = current.get(league.id)!;
        return { ...leagueView(league), season: seasonView(season), teamCount: countFor(teamCounts, season.id), divisionCount: countFor(divisionCounts, season.id) };
      }),
      page, pageSize: DIRECTORY_PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE)),
    };
  }

  // Scheduled games in the next seven days across all published leagues.
  async upcoming(limit = 8) {
    const rows = await this.gameQuery()
      .innerJoin('league.seasons as s', 's.id', 'g.season_id').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id').innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .select(['l.slug as league_slug', 'l.name as league_name', 'l.time_zone', 's.slug as season_slug', 'd.id as division_id', 'd.name as division_name'])
      .where('l.published_at', 'is not', null).where('l.slug', 'is not', null).where('l.archived_at', 'is', null).where('o.archived_at', 'is', null)
      .where('s.status', 'in', PUBLIC_SEASON_STATUSES).where('s.archived_at', 'is', null)
      .where('g.status', '=', 'scheduled').where('g.scheduled_at', '>=', sql<Date>`now()`).where('g.scheduled_at', '<', sql<Date>`now() + interval '7 days'`)
      .orderBy('g.scheduled_at').orderBy('g.id').limit(limit).execute();
    return rows.map((row) => ({ ...gameView(row), league: { slug: row.league_slug!, name: row.league_name, timeZone: row.time_zone }, season: { slug: row.season_slug }, division: { id: row.division_id, name: row.division_name } }));
  }

  private async resolveLeague(slug: string) {
    const league = await this.leagues().where('l.slug', '=', slug).executeTakeFirst();
    if (!league) throw new NotFoundException();
    return { league, seasons: sortSeasons(await this.seasonsOf([league.id])) };
  }

  async league(slug: string) {
    const { league, seasons } = await this.resolveLeague(slug);
    return { league: leagueView(league), seasons: seasons.map(seasonView), defaultSeason: seasons[0]?.slug ?? null };
  }

  private async resolveSeason(leagueSlug: string, seasonSlug: string) {
    const { league, seasons } = await this.resolveLeague(leagueSlug);
    const season = seasons.find((item) => item.slug === seasonSlug);
    if (!season) throw new NotFoundException();
    const divisions = await this.db.selectFrom('league.divisions as d')
      .select(['d.id', 'd.name', 'd.min_age', 'd.max_age', (eb) => eb.selectFrom('league.season_teams as st').select(sql<number>`count(*)::int`.as('n')).whereRef('st.division_id', '=', 'd.id').as('team_count')])
      .where('d.season_id', '=', season.id).orderBy('d.created_at').orderBy('d.id').execute() as DivisionRow[];
    return { league, seasons, season, divisions };
  }

  // The requested division, or the first one with teams.
  private division(divisions: DivisionRow[], id?: string) {
    const division = id ? divisions.find((item) => item.id === id) : divisions.find((item) => Number(item.team_count) > 0) ?? divisions[0];
    if (!division) throw new NotFoundException();
    return division;
  }

  async season(leagueSlug: string, seasonSlug: string) {
    const { league, seasons, season, divisions } = await this.resolveSeason(leagueSlug, seasonSlug);
    return { league: leagueView(league), seasons: seasons.map(seasonView), season: seasonView(season), divisions: divisions.map(divisionView), defaultDivision: divisions.length ? this.division(divisions).id : null };
  }

  private gameQuery() {
    return this.db.selectFrom('league.games as g')
      .innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id')
      .leftJoin('league.venues as v', 'v.id', 'g.venue_id')
      .select(['g.id', 'g.scheduled_at', 'g.status', 'g.stage', 'g.round', 'g.duration_minutes', 'g.home_score', 'g.away_score', 'g.forfeited_by_season_team_id',
        'h.id as home_id', 'ht.id as home_team_id', 'ht.name as home_name', 'ht.abbreviation as home_abbreviation',
        'a.id as away_id', 'at.id as away_team_id', 'at.name as away_name', 'at.abbreviation as away_abbreviation',
        'v.name as venue_name', 'v.address as venue_address']);
  }

  private divisionGames(seasonId: string, divisionId: string): Promise<GameRow[]> {
    return this.gameQuery().where('g.season_id', '=', seasonId).where('g.division_id', '=', divisionId)
      .orderBy(sql`g.scheduled_at asc nulls last`).orderBy('g.id').execute();
  }

  private divisionTeams(seasonId: string, divisionId: string): Promise<StatTeam[]> {
    return this.db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id')
      .select(['st.id', 't.id as teamId', 't.name', 't.abbreviation'])
      .where('st.season_id', '=', seasonId).where('st.division_id', '=', divisionId).orderBy('t.name').orderBy('st.id').execute();
  }

  // Standings follow the admin app: final preliminary games only, ranked by calculateStandings.
  private standingsRows(teams: StatTeam[], games: GameRow[]) {
    const results = games.filter((game) => game.status === 'completed' && game.stage === 'preliminary').map(resultGame);
    const byId = new Map(teams.map((team) => [team.id, team]));
    const rows = calculateStandings(teams.map(({ id, name }) => ({ id, name })), results);
    return {
      hasResults: results.length > 0,
      rows: rows.map((row, index) => ({
        rank: index + 1, team: byId.get(row.id)!, gamesPlayed: row.wins + row.losses, wins: row.wins, losses: row.losses, winPct: winPct(row.wins, row.losses),
        pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifference: row.pointDifference, ...teamForm(row.id, results),
      })),
    };
  }

  private async divisionData(leagueSlug: string, seasonSlug: string, divisionId?: string) {
    const { season, divisions } = await this.resolveSeason(leagueSlug, seasonSlug);
    const division = this.division(divisions, divisionId);
    const [teams, games] = await Promise.all([this.divisionTeams(season.id, division.id), this.divisionGames(season.id, division.id)]);
    return { division: divisionView(division), teams, games };
  }

  async games(leagueSlug: string, seasonSlug: string, divisionId?: string, teamId?: string, view: 'upcoming' | 'results' | 'all' = 'all') {
    const { division, teams, games } = await this.divisionData(leagueSlug, seasonSlug, divisionId);
    if (teamId && !teams.some((team) => team.id === teamId)) throw new NotFoundException();
    let rows = teamId ? games.filter((game) => game.home_id === teamId || game.away_id === teamId) : games;
    if (view === 'upcoming') rows = rows.filter((game) => game.status === 'scheduled');
    if (view === 'results') rows = rows.filter((game) => game.status === 'completed').reverse();
    return { division, games: rows.map(gameView) };
  }

  async standings(leagueSlug: string, seasonSlug: string, divisionId?: string) {
    const { division, teams, games } = await this.divisionData(leagueSlug, seasonSlug, divisionId);
    return { division, ...this.standingsRows(teams, games) };
  }

  // Team statistics include every final game in the division, playoffs included.
  async stats(leagueSlug: string, seasonSlug: string, divisionId?: string) {
    const { division, teams, games } = await this.divisionData(leagueSlug, seasonSlug, divisionId);
    const results = games.filter((game) => game.status === 'completed').map(resultGame);
    const rows = teamStats(teams, results);
    return { division, hasResults: results.length > 0, teams: rows, leaders: statLeaders(rows) };
  }

  async teams(leagueSlug: string, seasonSlug: string, divisionId?: string) {
    const { division, teams, games } = await this.divisionData(leagueSlug, seasonSlug, divisionId);
    const standings = this.standingsRows(teams, games);
    const ranks = new Map(standings.rows.map((row) => [row.team.id, row]));
    return {
      division, hasResults: standings.hasResults,
      teams: teams.map((team) => {
        const row = ranks.get(team.id)!;
        return { ...team, rank: row.rank, wins: row.wins, losses: row.losses, pointDifference: row.pointDifference, streak: row.streak };
      }),
    };
  }

  async team(leagueSlug: string, seasonSlug: string, seasonTeamId: string) {
    const { season, divisions } = await this.resolveSeason(leagueSlug, seasonSlug);
    const registration = await this.db.selectFrom('league.season_teams').select('division_id').where('id', '=', seasonTeamId).where('season_id', '=', season.id).executeTakeFirst();
    if (!registration) throw new NotFoundException();
    const division = this.division(divisions, registration.division_id);
    const [teams, games] = await Promise.all([this.divisionTeams(season.id, division.id), this.divisionGames(season.id, division.id)]);
    const team = teams.find((item) => item.id === seasonTeamId)!;
    const results = games.filter((game) => game.status === 'completed').map(resultGame);
    return {
      division: divisionView(division), team,
      standing: this.standingsRows(teams, games).rows.find((row) => row.team.id === seasonTeamId)!,
      stats: teamStats([team], results)[0],
      games: games.filter((game) => game.home_id === seasonTeamId || game.away_id === seasonTeamId).map(gameView),
    };
  }
}
