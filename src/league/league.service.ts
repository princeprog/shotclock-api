import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { calculateStandings } from './standings';
import { paginationMeta } from '../common/pagination';
import { CreateTeamDto, GameDto, GameFilterDto, JerseyDto, LeagueDto, NameDto, OrganizationSeasonFilterDto, OrganizationTeamFilterDto, OrganizationVenueFilterDto, RosterDto, RosterFilterDto, ScoreDto, SeasonDto, SeasonFilterDto, TeamDto, VenueDto } from './league.dto';

type Database = Kysely<DB> | Transaction<DB>;
const seasonDates = [sql<string | null>`start_date::text`.as('start_date'), sql<string | null>`end_date::text`.as('end_date')] as const;

@Injectable()
export class LeagueService {
  constructor(private readonly database: DatabaseService) {}
  private get db() { return this.database.db; }
  private name(value: string) { const result = value.trim(); if (!result) throw new BadRequestException('Name is required'); return result; }
  private async org(user: string, id: string, db: Database = this.db) {
    const row = await db.selectFrom('league.organizations').selectAll().where('id', '=', id).where('owner_user_id', '=', user).executeTakeFirst();
    if (!row) throw new NotFoundException(); return row;
  }
  private async league(user: string, id: string, db: Database = this.db) {
    const row = await db.selectFrom('league.leagues as l').innerJoin('league.organizations as o', 'o.id', 'l.organization_id').selectAll('l').where('l.id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!row) throw new NotFoundException(); return row;
  }
  private async season(user: string, id: string, db: Database = this.db, lock = false) {
    let q = db.selectFrom('league.seasons as s').innerJoin('league.leagues as l', 'l.id', 's.league_id').innerJoin('league.organizations as o', 'o.id', 'l.organization_id').selectAll('s').where('s.id', '=', id).where('o.owner_user_id', '=', user);
    if (lock) q = q.forUpdate('s');
    const row = await q.executeTakeFirst(); if (!row) throw new NotFoundException(); return row;
  }
  private async team(user: string, id: string, db: Database = this.db) {
    const row = await db.selectFrom('league.teams as t').innerJoin('league.leagues as l', 'l.id', 't.league_id').innerJoin('league.organizations as o', 'o.id', 'l.organization_id').selectAll('t').where('t.id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!row) throw new NotFoundException(); return row;
  }
  private editable(status: string) { if (status === 'completed') throw new BadRequestException('Completed seasons cannot be changed'); }
  private async mutation<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') throw new ConflictException('A matching registration or jersey number already exists');
      throw error;
    }
  }

  organizations(user: string) { return this.db.selectFrom('league.organizations').select(['id', 'name']).where('owner_user_id', '=', user).orderBy('name').execute(); }
  async createOrganization(user: string, dto: NameDto) { return this.db.insertInto('league.organizations').values({ owner_user_id: user, name: this.name(dto.name) }).returningAll().executeTakeFirstOrThrow(); }
  async getOrganization(user: string, id: string) { return this.org(user, id); }
  async editOrganization(user: string, id: string, dto: NameDto) { await this.org(user, id); return this.db.updateTable('league.organizations').set({ name: this.name(dto.name), updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
  async leagues(user: string, org: string) { await this.org(user, org); return this.db.selectFrom('league.leagues').selectAll().where('organization_id', '=', org).orderBy('name').execute(); }
  async createLeague(user: string, org: string, dto: LeagueDto) { await this.org(user, org); return this.db.insertInto('league.leagues').values({ organization_id: org, name: this.name(dto.name), location: dto.location?.trim() || null }).returningAll().executeTakeFirstOrThrow(); }
  async getLeague(user: string, id: string) { return this.league(user, id); }
  async editLeague(user: string, id: string, dto: LeagueDto) { await this.league(user, id); return this.db.updateTable('league.leagues').set({ name: this.name(dto.name), location: dto.location?.trim() || null, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
  async organizationSeasons(user: string, organization: string, filters: OrganizationSeasonFilterDto = {}) {
    await this.org(user, organization);
    if (filters.leagueId) {
      const league = await this.league(user, filters.leagueId);
      if (league.organization_id !== organization) throw new NotFoundException();
    }
    let query = this.db.selectFrom('league.seasons as s').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .selectAll('s').select(['l.name as league_name', sql<string | null>`s.start_date::text`.as('start_date'), sql<string | null>`s.end_date::text`.as('end_date')])
      .where('l.organization_id', '=', organization);
    if (filters.leagueId) query = query.where('s.league_id', '=', filters.leagueId);
    if (filters.status) query = query.where('s.status', '=', filters.status);
    const search = filters.search?.trim();
    if (search) query = query.where('s.name', 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    const count = await query.clearSelect().select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const meta = paginationMeta(Number(count.total), filters.page ?? 1, filters.pageSize ?? 10);
    const items = await query.orderBy('s.created_at', 'desc').orderBy('s.id', 'desc').limit(meta.pageSize).offset((meta.page - 1) * meta.pageSize).execute();
    return { items, ...meta };
  }
  async seasons(user: string, league: string, filters: SeasonFilterDto = {}) {
    await this.league(user, league);
    let query = this.db.selectFrom('league.seasons').selectAll().select(seasonDates).where('league_id', '=', league);
    if (filters.status) query = query.where('status', '=', filters.status);
    const search = filters.search?.trim();
    if (search) query = query.where('name', 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    const ordered = query.orderBy('created_at', 'desc').orderBy('id', 'desc');
    if (filters.page === undefined && filters.pageSize === undefined) return ordered.execute();
    const count = await query.clearSelect().select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const meta = paginationMeta(Number(count.total), filters.page ?? 1, filters.pageSize ?? 10);
    const items = await ordered.limit(meta.pageSize).offset((meta.page - 1) * meta.pageSize).execute();
    return { items, ...meta };
  }
  private dates(dto: SeasonDto) {
    if ((dto.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(dto.startDate)) || (dto.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(dto.endDate)) || (dto.startDate && dto.endDate && dto.startDate > dto.endDate)) throw new BadRequestException('Invalid season date range');
    return { name: this.name(dto.name), start_date: dto.startDate ?? null, end_date: dto.endDate ?? null };
  }
  async createSeason(user: string, league: string, dto: SeasonDto) { await this.league(user, league); return this.db.insertInto('league.seasons').values({ league_id: league, ...this.dates(dto) }).returningAll().returning(seasonDates).executeTakeFirstOrThrow(); }
  async getSeason(user: string, id: string) { await this.season(user, id); return this.db.selectFrom('league.seasons').selectAll().select(seasonDates).where('id', '=', id).executeTakeFirstOrThrow(); }
  async editSeason(user: string, id: string, dto: SeasonDto) { return this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); return tx.updateTable('league.seasons').set({ ...this.dates(dto), updated_at: new Date() }).where('id', '=', id).returningAll().returning(seasonDates).executeTakeFirstOrThrow(); }); }
  async transition(user: string, id: string, status: 'active' | 'completed') { return this.db.transaction().execute(async (tx) => {
    const season = await this.season(user, id, tx, true);
    if ((status === 'active' && season.status !== 'draft') || (status === 'completed' && season.status !== 'active')) throw new BadRequestException('Invalid season transition');
    if (status === 'completed') { const games = await tx.selectFrom('league.games').select(['status']).where('season_id', '=', id).execute(); if (!games.length || games.some((game) => game.status !== 'completed')) throw new BadRequestException('Complete all games before completing the season'); }
    return tx.updateTable('league.seasons').set({ status, updated_at: new Date() }).where('id', '=', id).returningAll().returning(seasonDates).executeTakeFirstOrThrow();
  }); }
  async teams(user: string, league: string) { await this.league(user, league); return this.db.selectFrom('league.teams').selectAll().where('league_id', '=', league).orderBy('name').execute(); }
  async organizationTeamSeasons(user: string, organization: string) {
    await this.org(user, organization);
    return this.db.selectFrom('league.seasons as s').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .select(['s.id', 's.name', 's.league_id', 's.status', 'l.name as league_name'])
      .where('l.organization_id', '=', organization).orderBy('l.name').orderBy('s.name').orderBy('s.id').execute();
  }
  async organizationTeams(user: string, organization: string, filters: OrganizationTeamFilterDto = {}) {
    await this.org(user, organization);
    if (filters.leagueId) {
      const league = await this.league(user, filters.leagueId);
      if (league.organization_id !== organization) throw new NotFoundException();
    }
    if (filters.seasonId) {
      const season = await this.season(user, filters.seasonId);
      const league = await this.league(user, season.league_id);
      if (league.organization_id !== organization || (filters.leagueId && filters.leagueId !== season.league_id)) throw new NotFoundException();
    }
    let query = this.db.selectFrom('league.teams as t')
      .innerJoin('league.leagues as l', 'l.id', 't.league_id')
      .leftJoin('league.season_teams as st', 'st.team_id', 't.id')
      .leftJoin('league.seasons as s', 's.id', 'st.season_id')
      .select(['t.id', 't.name', 't.abbreviation', 't.league_id', 'l.name as league_name', 'st.id as season_team_id', 's.id as season_id', 's.name as season_name', 's.status as season_status'])
      .where('l.organization_id', '=', organization);
    if (filters.leagueId) query = query.where('t.league_id', '=', filters.leagueId);
    if (filters.seasonId) {
      const seasonId = filters.seasonId;
      query = query.where(({ exists, selectFrom }) => exists(selectFrom('league.season_teams as selected').select('selected.id').whereRef('selected.team_id', '=', 't.id').where('selected.season_id', '=', seasonId)));
    }
    const search = filters.search?.trim();
    if (search) query = query.where('t.name', 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return query.orderBy('t.name').orderBy('t.id').orderBy('s.name').orderBy('s.id').execute();
  }
  async createTeam(user: string, league: string, dto: CreateTeamDto) { return this.db.transaction().execute(async (tx) => {
    await this.league(user, league, tx);
    const season = await this.season(user, dto.seasonId, tx, true);
    if (season.league_id !== league) throw new NotFoundException();
    this.editable(season.status);
    const team = await tx.insertInto('league.teams').values({ league_id: league, name: this.name(dto.name), abbreviation: dto.abbreviation?.trim() || null }).returningAll().executeTakeFirstOrThrow();
    await tx.insertInto('league.season_teams').values({ season_id: dto.seasonId, league_id: league, team_id: team.id, status: 'active' }).execute();
    return team;
  }); }
  async getTeam(user: string, id: string) { return this.team(user, id); }
  async editTeam(user: string, id: string, dto: TeamDto) { await this.team(user, id); return this.db.updateTable('league.teams').set({ name: this.name(dto.name), abbreviation: dto.abbreviation?.trim() || null, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
  async seasonTeams(user: string, season: string) { await this.season(user, season); return this.db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id').select(['st.id', 'st.team_id', 't.name', 't.abbreviation']).where('st.season_id', '=', season).orderBy('t.name').execute(); }
  async registerTeam(user: string, id: string, teamId: string) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); const team = await this.team(user, teamId, tx); if (team.league_id !== season.league_id) throw new NotFoundException(); return tx.insertInto('league.season_teams').values({ season_id: id, league_id: season.league_id, team_id: teamId, status: 'active' }).returningAll().executeTakeFirstOrThrow(); })); }
  private async seasonTeam(user: string, id: string, db: Database = this.db) {
    const row = await db.selectFrom('league.season_teams').selectAll().where('id', '=', id).executeTakeFirst(); if (!row) throw new NotFoundException(); await this.season(user, row.season_id, db); return row;
  }
  async getSeasonTeam(user: string, id: string) {
    const row = await this.db.selectFrom('league.season_teams as st')
      .innerJoin('league.teams as t', 't.id', 'st.team_id')
      .innerJoin('league.seasons as s', 's.id', 'st.season_id')
      .innerJoin('league.leagues as l', 'l.id', 'st.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['st.id', 'st.team_id', 't.name as team_name', 't.abbreviation', 's.id as season_id', 's.name as season_name', 's.status as season_status', 'l.id as league_id', 'l.name as league_name', 'o.id as organization_id'])
      .where('st.id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!row) throw new NotFoundException();
    return row;
  }
  async roster(user: string, id: string, filters: RosterFilterDto = {}) {
    await this.seasonTeam(user, id);
    let query = this.db.selectFrom('league.rosters as r').innerJoin('league.players as p', 'p.id', 'r.player_id')
      .select(['r.id', 'r.jersey_number', 'p.first_name', 'p.last_name']).where('r.season_team_id', '=', id);
    const search = filters.search?.trim();
    if (search) query = query.where(sql<string>`p.first_name || ' ' || p.last_name`, 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return query.orderBy('p.last_name').orderBy('p.first_name').orderBy('r.id').execute();
  }
  async addPlayer(user: string, id: string, dto: RosterDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const st = await this.seasonTeam(user, id, tx); const season = await this.season(user, st.season_id, tx, true); this.editable(season.status); const player = await tx.insertInto('league.players').values({ first_name: this.name(dto.firstName), last_name: this.name(dto.lastName), user_id: null, date_of_birth: null }).returning('id').executeTakeFirstOrThrow(); return tx.insertInto('league.rosters').values({ player_id: player.id, season_team_id: id, jersey_number: dto.jerseyNumber ?? null, status: 'active' }).returningAll().executeTakeFirstOrThrow(); })); }
  async editJersey(user: string, rosterId: string, dto: JerseyDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const roster = await tx.selectFrom('league.rosters').selectAll().where('id', '=', rosterId).executeTakeFirst(); if (!roster) throw new NotFoundException(); const st = await this.seasonTeam(user, roster.season_team_id, tx); const season = await this.season(user, st.season_id, tx, true); this.editable(season.status); return tx.updateTable('league.rosters').set({ jersey_number: dto.jerseyNumber ?? null, updated_at: new Date() }).where('id', '=', rosterId).returningAll().executeTakeFirstOrThrow(); })); }
  async venues(user: string, league: string) { await this.league(user, league); return this.db.selectFrom('league.venues').selectAll().where('league_id', '=', league).orderBy('name').execute(); }
  async createVenue(user: string, league: string, dto: VenueDto) { await this.league(user, league); return this.db.insertInto('league.venues').values({ league_id: league, name: this.name(dto.name), address: dto.address?.trim() || null }).returningAll().executeTakeFirstOrThrow(); }
  async organizationVenues(user: string, organization: string, filters: OrganizationVenueFilterDto = {}) {
    await this.org(user, organization);
    if (filters.leagueId) { const league = await this.league(user, filters.leagueId); if (league.organization_id !== organization) throw new NotFoundException(); }
    let query = this.db.selectFrom('league.venues as v').innerJoin('league.leagues as l', 'l.id', 'v.league_id').selectAll('v').select('l.name as league_name').where('l.organization_id', '=', organization);
    if (filters.leagueId) query = query.where('v.league_id', '=', filters.leagueId);
    const search = filters.search?.trim();
    if (search) query = query.where('v.name', 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return query.orderBy('v.name').orderBy('v.id').execute();
  }
  async editVenue(user: string, id: string, dto: VenueDto) {
    const venue = await this.db.selectFrom('league.venues as v').innerJoin('league.leagues as l', 'l.id', 'v.league_id').innerJoin('league.organizations as o', 'o.id', 'l.organization_id').select('v.id').where('v.id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!venue) throw new NotFoundException();
    return this.db.updateTable('league.venues').set({ name: this.name(dto.name), address: dto.address?.trim() || null, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  async games(user: string, season: string) { await this.season(user, season); return this.db.selectFrom('league.games as g').innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id').innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id').leftJoin('league.venues as v', 'v.id', 'g.venue_id').selectAll('g').select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name']).where('g.season_id', '=', season).orderBy('g.scheduled_at', 'asc').execute(); }
  async filteredGames(user: string, id: string, filters: GameFilterDto) {
    const season = await this.season(user, id);
    if (filters.teamId) { const team = await this.db.selectFrom('league.season_teams').select('id').where('id', '=', filters.teamId).where('season_id', '=', id).executeTakeFirst(); if (!team) throw new NotFoundException(); }
    if (filters.venueId) { const venue = await this.db.selectFrom('league.venues').select('id').where('id', '=', filters.venueId).where('league_id', '=', season.league_id).executeTakeFirst(); if (!venue) throw new NotFoundException(); }
    const date = (value?: string) => { if (!value) return undefined; if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) throw new BadRequestException('Date filters must include a timezone'); return new Date(value); };
    const from = date(filters.from); const to = date(filters.to);
    if (from && to && from >= to) throw new BadRequestException('Invalid date range');
    let query = this.db.selectFrom('league.games as g').innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id').innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id').leftJoin('league.venues as v', 'v.id', 'g.venue_id').selectAll('g').select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name']).where('g.season_id', '=', id);
    if (filters.status) query = query.where('g.status', '=', filters.status);
    if (filters.teamId) { const teamId = filters.teamId; query = query.where((eb) => eb.or([eb('g.home_season_team_id', '=', teamId), eb('g.away_season_team_id', '=', teamId)])); }
    if (filters.venueId) query = query.where('g.venue_id', '=', filters.venueId);
    if (from) query = query.where('g.scheduled_at', '>=', from);
    if (to) query = query.where('g.scheduled_at', '<', to);
    const search = filters.search?.trim();
    if (search) { const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`; query = query.where((eb) => eb.or([eb('ht.name', 'ilike', pattern), eb('at.name', 'ilike', pattern), eb('v.name', 'ilike', pattern)])); }
    const count = await query.clearSelect().select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const meta = paginationMeta(Number(count.total), filters.page ?? 1, filters.pageSize ?? 10);
    const items = await query.orderBy('g.scheduled_at', filters.sort ?? 'asc').orderBy('g.id', 'asc').limit(meta.pageSize).offset((meta.page - 1) * meta.pageSize).execute();
    return { items, ...meta };
  }
  private async gameValues(user: string, season: { id: string; league_id: string }, dto: GameDto, tx: Database) {
    if (dto.homeTeamId === dto.awayTeamId) throw new BadRequestException('Teams must differ');
    if (!/(Z|[+-]\d\d:\d\d)$/.test(dto.scheduledAt) || Number.isNaN(Date.parse(dto.scheduledAt))) throw new BadRequestException('A date and time with timezone is required');
    const teams = await tx.selectFrom('league.season_teams').select('id').where('season_id', '=', season.id).where('id', 'in', [dto.homeTeamId, dto.awayTeamId]).execute();
    if (teams.length !== 2) throw new NotFoundException();
    if (dto.venueId) { const venue = await tx.selectFrom('league.venues').select('id').where('id', '=', dto.venueId).where('league_id', '=', season.league_id).executeTakeFirst(); if (!venue) throw new NotFoundException(); }
    return { home_season_team_id: dto.homeTeamId, away_season_team_id: dto.awayTeamId, scheduled_at: new Date(dto.scheduledAt), venue_id: dto.venueId ?? null };
  }
  async createGame(user: string, id: string, dto: GameDto) { return this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); const values = await this.gameValues(user, season, dto, tx); return tx.insertInto('league.games').values({ season_id: id, ...values, home_score: null, away_score: null }).returningAll().executeTakeFirstOrThrow(); }); }
  async editGame(user: string, id: string, dto: GameDto) { return this.db.transaction().execute(async (tx) => { const initial = await tx.selectFrom('league.games').select(['season_id']).where('id', '=', id).executeTakeFirst(); if (!initial) throw new NotFoundException(); const season = await this.season(user, initial.season_id, tx, true); this.editable(season.status); const game = await tx.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); if (game.status !== 'scheduled') throw new BadRequestException('A completed game cannot be rescheduled'); const values = await this.gameValues(user, season, dto, tx); return tx.updateTable('league.games').set({ ...values, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }); }
  async score(user: string, id: string, dto: ScoreDto) { return this.db.transaction().execute(async (tx) => { const initial = await tx.selectFrom('league.games').select(['season_id']).where('id', '=', id).executeTakeFirst(); if (!initial) throw new NotFoundException(); const season = await this.season(user, initial.season_id, tx, true); const game = await tx.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); if (season.status === 'draft' || (season.status === 'completed' && game.status !== 'completed')) throw new BadRequestException('Season is not active'); if (dto.homeScore === dto.awayScore) throw new BadRequestException('Final scores cannot be tied'); return tx.updateTable('league.games').set({ home_score: dto.homeScore, away_score: dto.awayScore, status: 'completed', updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }); }
  async standings(user: string, season: string) {
    await this.season(user, season);
    const [teams, games] = await Promise.all([
      this.db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id').select(['st.id', 't.name']).where('st.season_id', '=', season).execute(),
      this.db.selectFrom('league.games').select(['home_season_team_id', 'away_season_team_id', 'home_score', 'away_score']).where('season_id', '=', season).where('status', '=', 'completed').where('home_score', 'is not', null).where('away_score', 'is not', null).execute(),
    ]);
    return calculateStandings(teams, games.map((game) => ({ homeId: game.home_season_team_id, awayId: game.away_season_team_id, homeScore: game.home_score!, awayScore: game.away_score! })));
  }
  async dashboard(user: string, season: string) { const [teams, games, standings] = await Promise.all([this.seasonTeams(user, season), this.games(user, season), this.standings(user, season)]); return { teamCount: teams.length, upcoming: games.filter((g) => g.status === 'scheduled' && g.scheduled_at !== null && new Date(g.scheduled_at).getTime() >= Date.now()), recent: games.filter((g) => g.status === 'completed').reverse(), standings }; }
}
