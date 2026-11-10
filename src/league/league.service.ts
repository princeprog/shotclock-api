import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { calculateStandings } from './standings';
import { ForfeitDto } from './forfeit.dto';
import { paginationMeta } from '../common/pagination';
import { CreateTeamDto, DivisionDto, PlayerDto, UpdateDivisionDto, UpdatePlayerDto, GameDto, GameFilterDto, JerseyDto, LeagueDto, NameDto, OrganizationSeasonFilterDto, OrganizationTeamFilterDto, OrganizationVenueFilterDto, RosterDto, RosterFilterDto, ScoreDto, SeasonDto, SeasonFilterDto, TeamDto, VenueDto } from './league.dto';

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
  private calendarDate(value: string, now = Date.now()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new BadRequestException('A valid calendar date is required');
    const latestCivilDate = new Date(now + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (value > latestCivilDate) throw new BadRequestException('Date of birth cannot be in the future');
    return value;
  }
  private ageRange(minAge: number | null, maxAge: number | null) {
    if (minAge !== null && maxAge !== null && minAge >= maxAge) throw new BadRequestException('Minimum age must be less than the upper age limit');
  }
  private eligible(birth: string | null, start: string | null, minAge: number | null, maxAge: number | null) {
    if (!birth) throw new BadRequestException('Player date of birth is required');
    this.calendarDate(birth);
    if (start && birth > start) throw new BadRequestException('Player was not born when the season started');
    if (minAge === null && maxAge === null) return;
    if (!start) throw new BadRequestException('A valid season start date is required');
    const years = Number(start.slice(0, 4)) - Number(birth.slice(0, 4)) - (start.slice(5) < birth.slice(5) ? 1 : 0);
    if ((minAge !== null && years < minAge) || (maxAge !== null && years >= maxAge)) throw new BadRequestException('Player is not eligible for this division');
  }
  private async playerLock(id: string, db: Database) { await sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`.execute(db); }
  private async scheduleLock(leagueId: string, db: Database) { await sql`select pg_advisory_xact_lock(hashtextextended('shotclock:schedule:league:' || ${leagueId}, 0))`.execute(db); }
  private requiresFork(user: string) { return sql<boolean>`exists (select 1 from league.organization_players op_other join league.organizations o_other on o_other.id = op_other.organization_id where op_other.player_id = p.id and o_other.owner_user_id <> ${user})`.as('requires_fork'); }
  private async divisionForSeason(season: string, id: string | undefined, db: Database = this.db) {
    let query = db.selectFrom('league.divisions').selectAll().where('season_id', '=', season);
    if (id) query = query.where('id', '=', id);
    const divisions = await query.orderBy('id').execute();
    if (id && !divisions.length) throw new NotFoundException();
    if (!id && divisions.length !== 1) throw new BadRequestException('Select a division');
    return divisions[0];
  }
  private async ensureDivisionRegistrationsEditable(db: Database, divisionId: string) {
    const schedule = await db.selectFrom('league.division_schedules').select('id').where('division_id', '=', divisionId).executeTakeFirst();
    if (schedule) throw new BadRequestException('Team registrations cannot change after a schedule has been generated for the division');
  }
  private async division(user: string, id: string, db: Database = this.db) {
    const division = await db.selectFrom('league.divisions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!division) throw new NotFoundException();
    await this.season(user, division.season_id, db);
    return division;
  }
  private async checkRegistrations(db: Database, filter: { seasonId?: string; divisionId?: string; playerId?: string }, overrides: { start?: string | null; minAge?: number | null; maxAge?: number | null; birth?: string | null } = {}) {
    let query = db.selectFrom('league.rosters as r').innerJoin('league.season_teams as st', 'st.id', 'r.season_team_id')
      .innerJoin('league.divisions as d', 'd.id', 'st.division_id').innerJoin('league.seasons as s', 's.id', 'st.season_id')
      .innerJoin('league.players as p', 'p.id', 'r.player_id')
      .select(['d.min_age', 'd.max_age', sql<string | null>`s.start_date::text`.as('start_date'), sql<string | null>`p.date_of_birth::text`.as('date_of_birth')]);
    if (filter.seasonId) query = query.where('s.id', '=', filter.seasonId);
    if (filter.divisionId) query = query.where('d.id', '=', filter.divisionId);
    if (filter.playerId) query = query.where('p.id', '=', filter.playerId);
    for (const row of await query.execute()) {
      const minAge = overrides.minAge !== undefined ? overrides.minAge : row.min_age;
      const maxAge = overrides.maxAge !== undefined ? overrides.maxAge : row.max_age;
      const birth = overrides.birth !== undefined ? overrides.birth : row.date_of_birth;
      const start = overrides.start !== undefined ? overrides.start : row.start_date;
      if (minAge !== null || maxAge !== null || (birth && start && birth > start)) this.eligible(birth, start, minAge, maxAge);
    }
  }
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
  async createSeason(user: string, league: string, dto: SeasonDto) { return this.db.transaction().execute(async (tx) => { await this.league(user, league, tx); const season = await tx.insertInto('league.seasons').values({ league_id: league, ...this.dates(dto) }).returningAll().returning(seasonDates).executeTakeFirstOrThrow(); await tx.insertInto('league.divisions').values({ season_id: season.id, name: 'Open', max_age: null }).execute(); return season; }); }
  async getSeason(user: string, id: string) { await this.season(user, id); return this.db.selectFrom('league.seasons').selectAll().select(seasonDates).where('id', '=', id).executeTakeFirstOrThrow(); }
  async editSeason(user: string, id: string, dto: SeasonDto) { return this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); const dates = this.dates(dto); await this.checkRegistrations(tx, { seasonId: id }, { start: dates.start_date }); return tx.updateTable('league.seasons').set({ ...dates, updated_at: new Date() }).where('id', '=', id).returningAll().returning(seasonDates).executeTakeFirstOrThrow(); }); }
  async divisions(user: string, seasonId: string) { await this.season(user, seasonId); return this.db.selectFrom('league.divisions').selectAll().where('season_id', '=', seasonId).orderBy('name').orderBy('id').execute(); }
  async createDivision(user: string, seasonId: string, dto: DivisionDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const season = await this.season(user, seasonId, tx, true); this.editable(season.status); const minAge = dto.minAge ?? null; const maxAge = dto.maxAge ?? null; this.ageRange(minAge, maxAge); return tx.insertInto('league.divisions').values({ season_id: seasonId, name: this.name(dto.name), min_age: minAge, max_age: maxAge }).returningAll().executeTakeFirstOrThrow(); })); }
  async editDivision(user: string, id: string, dto: UpdateDivisionDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const initial = await this.division(user, id, tx); const season = await this.season(user, initial.season_id, tx, true); this.editable(season.status); const division = await this.division(user, id, tx); const minAge = dto.minAge === undefined ? division.min_age : dto.minAge; const maxAge = dto.maxAge === undefined ? division.max_age : dto.maxAge; this.ageRange(minAge, maxAge); await this.checkRegistrations(tx, { divisionId: id }, { minAge, maxAge }); return tx.updateTable('league.divisions').set({ name: dto.name === undefined ? division.name : this.name(dto.name), min_age: minAge, max_age: maxAge, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); })); }
  async deleteDivision(user: string, id: string) { return this.db.transaction().execute(async (tx) => { const division = await this.division(user, id, tx); const season = await this.season(user, division.season_id, tx, true); if (season.status !== 'draft') throw new BadRequestException('Divisions can only be deleted in draft seasons'); const team = await tx.selectFrom('league.season_teams').select('id').where('division_id', '=', id).executeTakeFirst(); const game = await tx.selectFrom('league.games').select('id').where('division_id', '=', id).executeTakeFirst(); if (team || game) throw new BadRequestException('Only empty divisions can be deleted'); await tx.deleteFrom('league.divisions').where('id', '=', id).execute(); return { deleted: true }; }); }
  async transition(user: string, id: string, status: 'active' | 'completed') { return this.db.transaction().execute(async (tx) => {
    const season = await this.season(user, id, tx, true);
    if ((status === 'active' && season.status !== 'draft') || (status === 'completed' && season.status !== 'active')) throw new BadRequestException('Invalid season transition');
    if (status === 'completed') {
      const games = await tx.selectFrom('league.games').select(['status', 'stage', 'schedule_id', 'division_id']).where('season_id', '=', id).execute();
      if (!games.length || games.some((game) => game.status !== 'completed')) throw new BadRequestException('Complete all games before completing the season');
      const schedules = await tx.selectFrom('league.division_schedules as ds').innerJoin('league.divisions as d', 'd.id', 'ds.division_id')
        .select(['ds.id', 'ds.division_id', 'ds.third_place']).where('d.season_id', '=', id).where('ds.playoffs', '=', true).execute();
      for (const schedule of schedules) {
        const hasCompleted = (stage: string) => games.some((game) => game.schedule_id === schedule.id && game.division_id === schedule.division_id && game.stage === stage && game.status === 'completed');
        if (!hasCompleted('final') || (schedule.third_place && !hasCompleted('third_place'))) throw new BadRequestException('Complete the required playoff games before completing the season');
      }
    }
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
      .leftJoin('league.divisions as d', 'd.id', 'st.division_id')
      .select(['t.id', 't.name', 't.abbreviation', 't.league_id', 'l.name as league_name', 'st.id as season_team_id', 's.id as season_id', 's.name as season_name', 's.status as season_status', 'st.division_id', 'd.name as division_name'])
      .where('l.organization_id', '=', organization);
    if (filters.leagueId) query = query.where('t.league_id', '=', filters.leagueId);
    const paginated = filters.page !== undefined || filters.pageSize !== undefined;
    if (filters.seasonId) {
      const seasonId = filters.seasonId;
      query = paginated
        ? query.where('st.season_id', '=', seasonId)
        : query.where(({ exists, selectFrom }) => exists(selectFrom('league.season_teams as selected').select('selected.id').whereRef('selected.team_id', '=', 't.id').where('selected.season_id', '=', seasonId)));
    }
    if (filters.divisionId) { if (!filters.seasonId) throw new BadRequestException('A season is required when filtering by division'); await this.divisionForSeason(filters.seasonId, filters.divisionId); query = query.where('st.division_id', '=', filters.divisionId); }
    const search = filters.search?.trim();
    if (search) query = query.where('t.name', 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    const ordered = query.orderBy('t.name').orderBy('t.id').orderBy('s.name').orderBy('s.id');
    if (!paginated) return ordered.execute();
    const count = await query.clearSelect().select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const meta = paginationMeta(Number(count.total), filters.page ?? 1, filters.pageSize ?? 10);
    const items = await ordered.orderBy('st.id').limit(meta.pageSize).offset((meta.page - 1) * meta.pageSize).execute();
    return { items, ...meta };
  }
  async createTeam(user: string, league: string, dto: CreateTeamDto) { return this.db.transaction().execute(async (tx) => {
    await this.league(user, league, tx);
    const season = await this.season(user, dto.seasonId, tx, true);
    if (season.league_id !== league) throw new NotFoundException();
    this.editable(season.status);
    if (dto.divisionId && dto.divisionIds) throw new BadRequestException('Choose either divisionId or divisionIds');
    const divisionIds = dto.divisionIds ?? [dto.divisionId];
    const divisions: Awaited<ReturnType<typeof this.divisionForSeason>>[] = [];
    for (const id of divisionIds) divisions.push(await this.divisionForSeason(season.id, id, tx));
    for (const division of divisions) await this.ensureDivisionRegistrationsEditable(tx, division.id);
    const team = await tx.insertInto('league.teams').values({ league_id: league, name: this.name(dto.name), abbreviation: dto.abbreviation?.trim() || null }).returningAll().executeTakeFirstOrThrow();
    await tx.insertInto('league.season_teams').values(divisions.map((division) => ({ season_id: dto.seasonId, division_id: division.id, league_id: league, team_id: team.id, status: 'active' }))).execute();
    return { ...team, division_id: divisions[0].id, division_name: divisions[0].name };
  }); }
  async getTeam(user: string, id: string) { return this.team(user, id); }
  async editTeam(user: string, id: string, dto: TeamDto) { await this.team(user, id); return this.db.updateTable('league.teams').set({ name: this.name(dto.name), abbreviation: dto.abbreviation?.trim() || null, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
  async seasonTeams(user: string, season: string, divisionId?: string) { await this.season(user, season); const division = await this.divisionForSeason(season, divisionId); return this.db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id').innerJoin('league.divisions as d', 'd.id', 'st.division_id').select(['st.id', 'st.team_id', 'st.division_id', 'd.name as division_name', 't.name', 't.abbreviation']).where('st.season_id', '=', season).where('st.division_id', '=', division.id).orderBy('t.name').execute(); }
  async registerTeam(user: string, id: string, teamId: string, divisionId?: string) { return this.mutation(() => this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); const team = await this.team(user, teamId, tx); if (team.league_id !== season.league_id) throw new NotFoundException(); const division = await this.divisionForSeason(id, divisionId, tx); await this.ensureDivisionRegistrationsEditable(tx, division.id); const registration = await tx.insertInto('league.season_teams').values({ season_id: id, division_id: division.id, league_id: season.league_id, team_id: teamId, status: 'active' }).returningAll().executeTakeFirstOrThrow(); return { ...registration, division_name: division.name }; })); }
  private async seasonTeam(user: string, id: string, db: Database = this.db) {
    const row = await db.selectFrom('league.season_teams').selectAll().where('id', '=', id).executeTakeFirst(); if (!row) throw new NotFoundException(); await this.season(user, row.season_id, db); return row;
  }
  private async draftTeamRegistration(user: string, id: string, tx: Database) {
    const initial = await this.seasonTeam(user, id, tx);
    const season = await this.season(user, initial.season_id, tx, true);
    if (season.status !== 'draft') throw new BadRequestException('Team registration corrections require a draft season');
    const team = await this.seasonTeam(user, id, tx);
    return { team, season };
  }
  private async ensureNoGames(tx: Database, id: string) {
    const game = await tx.selectFrom('league.games').select('id').where((eb) => eb.or([eb('home_season_team_id', '=', id), eb('away_season_team_id', '=', id)])).executeTakeFirst();
    if (game) throw new BadRequestException('This registration has scheduled games; resolve them before changing it');
  }
  async moveTeamRegistration(user: string, id: string, divisionId: string) { return this.mutation(() => this.db.transaction().execute(async (tx) => {
    const { team, season } = await this.draftTeamRegistration(user, id, tx);
    const division = await this.divisionForSeason(season.id, divisionId, tx);
    if (team.division_id === division.id) return team;
    await this.ensureDivisionRegistrationsEditable(tx, team.division_id);
    await this.ensureDivisionRegistrationsEditable(tx, division.id);
    await this.ensureNoGames(tx, id);
    const dates = await tx.selectFrom('league.seasons').select(sql<string | null>`start_date::text`.as('start_date')).where('id', '=', season.id).executeTakeFirstOrThrow();
    const players = await tx.selectFrom('league.rosters as r').innerJoin('league.players as p', 'p.id', 'r.player_id').select(['p.first_name', 'p.last_name', sql<string | null>`p.date_of_birth::text`.as('date_of_birth')]).where('r.season_team_id', '=', id).execute();
    for (const player of players) {
      try { if (division.min_age !== null || division.max_age !== null || player.date_of_birth) this.eligible(player.date_of_birth, dates.start_date, division.min_age, division.max_age); }
      catch (error) { if (error instanceof BadRequestException) throw new BadRequestException(`${player.first_name} ${player.last_name}: ${error.message}`); throw error; }
    }
    return tx.updateTable('league.season_teams').set({ division_id: division.id, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  })); }
  async removeTeamRegistration(user: string, id: string) { return this.db.transaction().execute(async (tx) => {
    const { team } = await this.draftTeamRegistration(user, id, tx);
    await this.ensureDivisionRegistrationsEditable(tx, team.division_id);
    await this.ensureNoGames(tx, id);
    const roster = await tx.selectFrom('league.rosters').select('id').where('season_team_id', '=', id).executeTakeFirst();
    if (roster) throw new BadRequestException('Remove or move roster players before removing this team registration');
    await tx.deleteFrom('league.season_teams').where('id', '=', id).execute();
    return team;
  }); }
  async removeRosterRegistration(user: string, id: string) { return this.db.transaction().execute(async (tx) => {
    const initial = await tx.selectFrom('league.rosters').selectAll().where('id', '=', id).executeTakeFirst();
    if (!initial) throw new NotFoundException();
    await this.playerLock(initial.player_id, tx);
    const season = await this.season(user, initial.season_id, tx, true);
    if (season.status !== 'draft') throw new BadRequestException('Roster removal requires a draft season');
    const roster = await tx.selectFrom('league.rosters').selectAll().where('id', '=', id).executeTakeFirst();
    if (!roster || roster.player_id !== initial.player_id) throw new ConflictException('Roster changed; retry the removal');
    const stats = await tx.selectFrom('league.player_game_stats').select('id').where('roster_id', '=', id).executeTakeFirst();
    if (stats) throw new BadRequestException('This roster entry has game statistics and cannot be removed');
    await tx.deleteFrom('league.rosters').where('id', '=', id).execute();
    return roster;
  }); }
  async getSeasonTeam(user: string, id: string) {
    const row = await this.db.selectFrom('league.season_teams as st')
      .innerJoin('league.teams as t', 't.id', 'st.team_id')
      .innerJoin('league.seasons as s', 's.id', 'st.season_id')
      .innerJoin('league.leagues as l', 'l.id', 'st.league_id')
      .innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .innerJoin('league.divisions as d', 'd.id', 'st.division_id')
      .select(['st.id', 'st.team_id', 'st.division_id', 'd.name as division_name', 't.name as team_name', 't.abbreviation', 's.id as season_id', 's.name as season_name', 's.status as season_status', 'l.id as league_id', 'l.name as league_name', 'o.id as organization_id'])
      .where('st.id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!row) throw new NotFoundException();
    return row;
  }
  async roster(user: string, id: string, filters: RosterFilterDto = {}) {
    await this.seasonTeam(user, id);
    let query = this.db.selectFrom('league.rosters as r').innerJoin('league.players as p', 'p.id', 'r.player_id')
      .select(['r.id', 'r.player_id', 'r.jersey_number', 'p.first_name', 'p.last_name', 'p.position', sql<string | null>`p.date_of_birth::text`.as('date_of_birth'), this.requiresFork(user)]).where('r.season_team_id', '=', id);
    const search = filters.search?.trim();
    if (search) query = query.where(sql<string>`p.first_name || ' ' || p.last_name`, 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return query.orderBy('p.last_name').orderBy('p.first_name').orderBy('r.id').execute();
  }
  async players(user: string, organization: string, filters: RosterFilterDto = {}) {
    await this.org(user, organization);
    let query = this.db.selectFrom('league.players as p').innerJoin('league.organization_players as op', 'op.player_id', 'p.id').select(['p.id', 'p.first_name', 'p.last_name', 'p.position', sql<string | null>`p.date_of_birth::text`.as('date_of_birth'), this.requiresFork(user)]).where('op.organization_id', '=', organization);
    const search = filters.search?.trim();
    if (search) query = query.where(sql<string>`p.first_name || ' ' || p.last_name`, 'ilike', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return query.orderBy('p.last_name').orderBy('p.first_name').orderBy('p.id').execute();
  }
  private playerValues(dto: PlayerDto) { return { first_name: this.name(dto.firstName), last_name: this.name(dto.lastName), date_of_birth: this.calendarDate(dto.dateOfBirth), position: dto.position?.trim() || null }; }
  async createPlayer(user: string, organization: string, dto: PlayerDto) { return this.db.transaction().execute(async (tx) => { await this.org(user, organization, tx); const player = await tx.insertInto('league.players').values({ ...this.playerValues(dto), user_id: null }).returning(['id', 'first_name', 'last_name', 'position', sql<string>`date_of_birth::text`.as('date_of_birth')]).executeTakeFirstOrThrow(); await tx.insertInto('league.organization_players').values({ organization_id: organization, player_id: player.id }).execute(); return player; }); }
  async forkPlayer(user: string, organization: string, id: string) { return this.db.transaction().execute(async (tx) => {
    await this.org(user, organization, tx);
    await this.playerLock(id, tx);
    const source = await tx.selectFrom('league.players as p').innerJoin('league.organization_players as op', 'op.player_id', 'p.id')
      .select(['p.first_name', 'p.last_name', 'p.position', sql<string | null>`p.date_of_birth::text`.as('date_of_birth')])
      .where('op.organization_id', '=', organization).where('p.id', '=', id).executeTakeFirst();
    if (!source) throw new NotFoundException();
    const registrations = await tx.selectFrom('league.rosters as r').innerJoin('league.season_teams as st', 'st.id', 'r.season_team_id')
      .innerJoin('league.leagues as l', 'l.id', 'st.league_id').select(['r.id', 'r.season_id'])
      .where('r.player_id', '=', id).where('l.organization_id', '=', organization).orderBy('r.season_id').execute();
    for (const registration of registrations) await this.season(user, registration.season_id, tx, true);
    const copy = await tx.insertInto('league.players').values({ ...source, user_id: null })
      .returning(['id', 'first_name', 'last_name', 'position', sql<string | null>`date_of_birth::text`.as('date_of_birth')]).executeTakeFirstOrThrow();
    await tx.insertInto('league.organization_players').values({ organization_id: organization, player_id: copy.id }).execute();
    if (registrations.length) await tx.updateTable('league.rosters').set({ player_id: copy.id, updated_at: new Date() })
      .where('id', 'in', registrations.map((registration) => registration.id)).where('player_id', '=', id).execute();
    await tx.deleteFrom('league.organization_players').where('organization_id', '=', organization).where('player_id', '=', id).execute();
    return { ...copy, requires_fork: false };
  }); }
  async editPlayer(user: string, id: string, dto: UpdatePlayerDto) { return this.db.transaction().execute(async (tx) => {
    await this.playerLock(id, tx);
    const owned = await tx.selectFrom('league.organization_players as op').innerJoin('league.organizations as o', 'o.id', 'op.organization_id').select('op.player_id').where('op.player_id', '=', id).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!owned) throw new NotFoundException();
    const other = await tx.selectFrom('league.organization_players as op').innerJoin('league.organizations as o', 'o.id', 'op.organization_id').select('op.player_id').where('op.player_id', '=', id).where('o.owner_user_id', '!=', user).executeTakeFirst();
    if (other) throw new NotFoundException();
    const registrations = await tx.selectFrom('league.rosters').select('season_id').where('player_id', '=', id).orderBy('season_id').execute();
    for (const row of registrations) await tx.selectFrom('league.seasons').select('id').where('id', '=', row.season_id).forUpdate().executeTakeFirstOrThrow();
    const current = await tx.selectFrom('league.players').select(['first_name', 'last_name', 'position', sql<string | null>`date_of_birth::text`.as('date_of_birth')]).where('id', '=', id).executeTakeFirstOrThrow();
    const values = { first_name: dto.firstName === undefined ? current.first_name : this.name(dto.firstName), last_name: dto.lastName === undefined ? current.last_name : this.name(dto.lastName), date_of_birth: dto.dateOfBirth === undefined ? current.date_of_birth : this.calendarDate(dto.dateOfBirth), position: dto.position === undefined ? current.position : dto.position?.trim() || null };
    await this.checkRegistrations(tx, { playerId: id }, { birth: values.date_of_birth });
    return tx.updateTable('league.players').set({ ...values, updated_at: new Date() }).where('id', '=', id).returning(['id', 'first_name', 'last_name', 'position', sql<string>`date_of_birth::text`.as('date_of_birth')]).executeTakeFirstOrThrow();
  }); }
  async addPlayer(user: string, id: string, dto: RosterDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => {
    await this.playerLock(dto.playerId, tx);
    const st = await this.seasonTeam(user, id, tx); const season = await this.season(user, st.season_id, tx, true); this.editable(season.status);
    const league = await this.league(user, season.league_id, tx);
    const player = await tx.selectFrom('league.players as p').innerJoin('league.organization_players as op', 'op.player_id', 'p.id').select(sql<string | null>`p.date_of_birth::text`.as('date_of_birth')).where('p.id', '=', dto.playerId).where('op.organization_id', '=', league.organization_id).executeTakeFirst();
    if (!player) throw new NotFoundException();
    const division = await this.divisionForSeason(season.id, st.division_id, tx);
    const dates = await tx.selectFrom('league.seasons').select(sql<string | null>`start_date::text`.as('start_date')).where('id', '=', season.id).executeTakeFirstOrThrow();
    this.eligible(player.date_of_birth, dates.start_date, division.min_age, division.max_age);
    return tx.insertInto('league.rosters').values({ player_id: dto.playerId, season_id: season.id, season_team_id: id, jersey_number: dto.jerseyNumber ?? null, status: 'active' }).returningAll().executeTakeFirstOrThrow();
  })); }
  async editJersey(user: string, rosterId: string, dto: JerseyDto) { return this.mutation(() => this.db.transaction().execute(async (tx) => {
    const initial = await tx.selectFrom('league.rosters').selectAll().where('id', '=', rosterId).executeTakeFirst(); if (!initial) throw new NotFoundException();
    await this.playerLock(initial.player_id, tx);
    const season = await this.season(user, initial.season_id, tx, true); this.editable(season.status);
    const roster = await tx.selectFrom('league.rosters').selectAll().where('id', '=', rosterId).executeTakeFirstOrThrow();
    if (roster.player_id !== initial.player_id) throw new ConflictException('Roster changed; retry the update');
    if (dto.seasonTeamId && dto.seasonTeamId !== roster.season_team_id) {
      if (season.status !== 'draft') throw new BadRequestException('Roster transfers require a draft season');
      const target = await this.seasonTeam(user, dto.seasonTeamId, tx); if (target.season_id !== season.id) throw new NotFoundException();
      const division = await this.divisionForSeason(season.id, target.division_id, tx);
      const dates = await tx.selectFrom('league.seasons').select(sql<string | null>`start_date::text`.as('start_date')).where('id', '=', season.id).executeTakeFirstOrThrow();
      const player = await tx.selectFrom('league.players').select(sql<string | null>`date_of_birth::text`.as('date_of_birth')).where('id', '=', roster.player_id).executeTakeFirstOrThrow();
      this.eligible(player.date_of_birth, dates.start_date, division.min_age, division.max_age);
    }
    return tx.updateTable('league.rosters').set({ season_team_id: dto.seasonTeamId ?? roster.season_team_id, jersey_number: dto.jerseyNumber === undefined ? roster.jersey_number : dto.jerseyNumber, updated_at: new Date() }).where('id', '=', rosterId).returningAll().executeTakeFirstOrThrow();
  })); }
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
  async games(user: string, season: string, divisionId?: string) { await this.season(user, season); const division = await this.divisionForSeason(season, divisionId); return this.db.selectFrom('league.games as g').innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id').innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id').leftJoin('league.venues as v', 'v.id', 'g.venue_id').selectAll('g').select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name']).where('g.season_id', '=', season).where('g.division_id', '=', division.id).orderBy('g.scheduled_at', 'asc').execute(); }
  async filteredGames(user: string, id: string, filters: GameFilterDto) {
    const season = await this.season(user, id);
    if (filters.scope === 'season' && filters.divisionId) throw new BadRequestException('Choose either season scope or a division');
    const division = filters.scope === 'season' ? null : await this.divisionForSeason(id, filters.divisionId);
    if (filters.teamId) { const team = await this.db.selectFrom('league.season_teams').select('id').where('id', '=', filters.teamId).where('season_id', '=', id).executeTakeFirst(); if (!team) throw new NotFoundException(); }
    if (filters.venueId) { const venue = await this.db.selectFrom('league.venues').select('id').where('id', '=', filters.venueId).where('league_id', '=', season.league_id).executeTakeFirst(); if (!venue) throw new NotFoundException(); }
    const date = (value?: string) => { if (!value) return undefined; if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) throw new BadRequestException('Date filters must include a timezone'); return new Date(value); };
    const from = date(filters.from); const to = date(filters.to);
    if (from && to && from >= to) throw new BadRequestException('Invalid date range');
    let query = this.db.selectFrom('league.games as g').innerJoin('league.divisions as d', 'd.id', 'g.division_id').innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id').innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id').leftJoin('league.venues as v', 'v.id', 'g.venue_id').selectAll('g').select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name', 'd.name as division_name']).where('g.season_id', '=', id);
    if (division) query = query.where('g.division_id', '=', division.id);
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
    const teams = await tx.selectFrom('league.season_teams').select(['id', 'division_id']).where('season_id', '=', season.id).where('id', 'in', [dto.homeTeamId, dto.awayTeamId]).execute();
    if (teams.length !== 2) throw new NotFoundException();
    if (teams[0].division_id !== teams[1].division_id) throw new BadRequestException('Teams must belong to the same division');
    if (dto.venueId) { const venue = await tx.selectFrom('league.venues').select('id').where('id', '=', dto.venueId).where('league_id', '=', season.league_id).executeTakeFirst(); if (!venue) throw new NotFoundException(); }
    return { division_id: teams[0].division_id, home_season_team_id: dto.homeTeamId, away_season_team_id: dto.awayTeamId, scheduled_at: new Date(dto.scheduledAt), venue_id: dto.venueId ?? null };
  }
  async createGame(user: string, id: string, dto: GameDto) { return this.db.transaction().execute(async (tx) => { const season = await this.season(user, id, tx, true); this.editable(season.status); await this.scheduleLock(season.league_id, tx); const values = await this.gameValues(user, season, dto, tx); return tx.insertInto('league.games').values({ season_id: id, ...values, duration_minutes: dto.durationMinutes ?? null, home_score: null, away_score: null }).returningAll().executeTakeFirstOrThrow(); }); }
  async editGame(user: string, id: string, dto: GameDto) { return this.db.transaction().execute(async (tx) => {
    const initial = await tx.selectFrom('league.games').select(['season_id']).where('id', '=', id).executeTakeFirst(); if (!initial) throw new NotFoundException();
    const season = await this.season(user, initial.season_id, tx, true); this.editable(season.status); await this.scheduleLock(season.league_id, tx);
    const game = await tx.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (game.status !== 'scheduled') throw new BadRequestException('A completed game cannot be rescheduled');
    if (game.schedule_id && (game.home_season_team_id !== dto.homeTeamId || game.away_season_team_id !== dto.awayTeamId)) throw new BadRequestException('Generated game participants cannot be changed');
    const values = await this.gameValues(user, season, dto, tx);
    const duration = dto.durationMinutes ?? game.duration_minutes ?? 60;
    const scheduleChanged = (game.scheduled_at ? new Date(game.scheduled_at).getTime() : null) !== values.scheduled_at.getTime()
      || game.venue_id !== values.venue_id || (dto.durationMinutes !== undefined && game.duration_minutes !== dto.durationMinutes);
    const participantsChanged = game.home_season_team_id !== values.home_season_team_id || game.away_season_team_id !== values.away_season_team_id;
    if (!scheduleChanged && !participantsChanged) return game;

    const start = values.scheduled_at.getTime();
    const end = start + duration * 60_000;
    const existing = await tx.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id')
      .select(['g.id', 'g.home_season_team_id', 'g.away_season_team_id', 'g.scheduled_at', 'g.venue_id', 'g.duration_minutes'])
      .where('s.league_id', '=', season.league_id).where('g.id', '!=', id).where('g.scheduled_at', 'is not', null)
      .where('g.scheduled_at', '<', new Date(end)).execute();
    const teams = [values.home_season_team_id, values.away_season_team_id];
    for (const other of existing) {
      if (!other.scheduled_at || other.id === id) continue;
      const otherStart = new Date(other.scheduled_at).getTime();
      if (otherStart >= end || otherStart + (other.duration_minutes ?? duration) * 60_000 <= start) continue;
      if ((values.venue_id && values.venue_id === other.venue_id) || teams.includes(other.home_season_team_id) || teams.includes(other.away_season_team_id)) {
        throw new BadRequestException('Game conflicts with another game at this venue or involving a team');
      }
    }
    const updated = await tx.updateTable('league.games').set({ ...values, ...(scheduleChanged ? { duration_minutes: duration } : {}), updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    if (scheduleChanged) await tx.insertInto('league.game_schedule_changes').values({
      game_id: id, changed_by_user_id: user, old_scheduled_at: game.scheduled_at, new_scheduled_at: values.scheduled_at,
      old_venue_id: game.venue_id, new_venue_id: values.venue_id, old_duration_minutes: game.duration_minutes, new_duration_minutes: duration,
    }).execute();
    return updated;
  }); }
  async scheduleHistory(user: string, id: string) {
    const game = await this.db.selectFrom('league.games').select('season_id').where('id', '=', id).executeTakeFirst();
    if (!game) throw new NotFoundException();
    await this.season(user, game.season_id);
    return this.db.selectFrom('league.game_schedule_changes as c')
      .leftJoin('league.venues as old_venue', 'old_venue.id', 'c.old_venue_id')
      .leftJoin('league.venues as new_venue', 'new_venue.id', 'c.new_venue_id')
      .select(['c.id', 'c.old_scheduled_at', 'c.new_scheduled_at', 'c.old_venue_id', 'c.new_venue_id', 'old_venue.name as old_venue_name', 'new_venue.name as new_venue_name', 'c.old_duration_minutes', 'c.new_duration_minutes', 'c.changed_at'])
      .where('c.game_id', '=', id).orderBy('c.changed_at', 'desc').orderBy('c.id', 'desc').execute();
  }
  private async preliminaryStandings(db: Database, seasonId: string, divisionId: string, proposed?: { game: Selectable<DB['league.games']>; score: ScoreDto }) {
    const teams = await db.selectFrom('league.season_teams as st').innerJoin('league.teams as t', 't.id', 'st.team_id').select(['st.id', 't.name']).where('st.season_id', '=', seasonId).where('st.division_id', '=', divisionId).execute();
    const games = await db.selectFrom('league.games').select(['id', 'home_season_team_id', 'away_season_team_id', 'home_score', 'away_score']).where('season_id', '=', seasonId).where('division_id', '=', divisionId).where('stage', '=', 'preliminary').where('status', '=', 'completed').where('home_score', 'is not', null).where('away_score', 'is not', null).execute();
    const results = games.filter((game) => game.id !== proposed?.game.id).map((game) => ({ homeId: game.home_season_team_id, awayId: game.away_season_team_id, homeScore: game.home_score!, awayScore: game.away_score! }));
    if (proposed) results.push({ homeId: proposed.game.home_season_team_id, awayId: proposed.game.away_season_team_id, homeScore: proposed.score.homeScore, awayScore: proposed.score.awayScore });
    return calculateStandings(teams, results);
  }
  private semifinalPairings(standings: { id: string }[]) {
    const seeds = standings.slice(0, 4).map((row) => row.id);
    if (seeds.length < 4) return JSON.stringify(seeds);
    return JSON.stringify([[seeds[0], seeds[3]].sort(), [seeds[1], seeds[2]].sort()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
  }
  private async writeGameResult(tx: Transaction<DB>, seasonId: string, game: Selectable<DB['league.games']>, dto: ScoreDto, forfeitingTeamId: string | null) {
    if (dto.homeScore === dto.awayScore) throw new BadRequestException('Final scores cannot be tied');
    if (game.stage === 'preliminary') {
      const semifinal = await tx.selectFrom('league.games').select('id').where('season_id', '=', seasonId).where('division_id', '=', game.division_id).where('stage', '=', 'semifinal').executeTakeFirst();
      if (semifinal) {
        const before = await this.preliminaryStandings(tx, seasonId, game.division_id);
        const after = await this.preliminaryStandings(tx, seasonId, game.division_id, { game, score: dto });
        if (this.semifinalPairings(before) !== this.semifinalPairings(after)) throw new BadRequestException('Score would change existing semifinal pairings');
      }
    } else if (game.stage === 'semifinal' && game.status === 'completed' && game.home_score !== null && game.away_score !== null && (game.home_score > game.away_score) !== (dto.homeScore > dto.awayScore)) {
      const next = await tx.selectFrom('league.games').select('id').where('season_id', '=', seasonId).where('division_id', '=', game.division_id).where('schedule_id', '=', game.schedule_id).where('stage', 'in', ['final', 'third_place']).executeTakeFirst();
      if (next) throw new BadRequestException('Semifinal winner cannot change after the final or third-place game is created');
    }
    return tx.updateTable('league.games').set({ home_score: dto.homeScore, away_score: dto.awayScore, forfeited_by_season_team_id: forfeitingTeamId, status: 'completed', updated_at: new Date() }).where('id', '=', game.id).returningAll().executeTakeFirstOrThrow();
  }
  async score(user: string, id: string, dto: ScoreDto) { return this.db.transaction().execute(async (tx) => {
    const initial = await tx.selectFrom('league.games').select(['season_id']).where('id', '=', id).executeTakeFirst(); if (!initial) throw new NotFoundException();
    const season = await this.season(user, initial.season_id, tx, true);
    const game = await tx.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (season.status === 'draft' || (season.status === 'completed' && game.status !== 'completed')) throw new BadRequestException('Season is not active');
    return this.writeGameResult(tx, season.id, game, dto, null);
  }); }
  async forfeit(user: string, id: string, dto: ForfeitDto) { return this.db.transaction().execute(async (tx) => {
    const initial = await tx.selectFrom('league.games').select('season_id').where('id', '=', id).executeTakeFirst();
    if (!initial) throw new NotFoundException();
    const season = await this.season(user, initial.season_id, tx, true);
    const game = await tx.selectFrom('league.games').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (season.status === 'draft' || (season.status === 'completed' && game.status !== 'completed')) throw new BadRequestException('Season is not active');
    if (game.status === 'completed' && !game.forfeited_by_season_team_id) throw new BadRequestException('A played result cannot be marked as a forfeit');
    if (dto.forfeitingTeamId !== game.home_season_team_id && dto.forfeitingTeamId !== game.away_season_team_id) throw new BadRequestException('The forfeiting team must be a participant in this game');
    const stats = await tx.selectFrom('league.player_game_stats').select('id').where('game_id', '=', id).executeTakeFirst();
    if (stats) throw new BadRequestException('A game with player statistics cannot be marked as a forfeit');
    const homeForfeits = dto.forfeitingTeamId === game.home_season_team_id;
    return this.writeGameResult(tx, season.id, game, { homeScore: homeForfeits ? 0 : 20, awayScore: homeForfeits ? 20 : 0 }, dto.forfeitingTeamId);
  }); }
  async standings(user: string, season: string, divisionId?: string) {
    await this.season(user, season);
    const division = await this.divisionForSeason(season, divisionId);
    return this.preliminaryStandings(this.db, season, division.id);
  }
  async dashboard(user: string, season: string, divisionId?: string) { await this.season(user, season); const division = await this.divisionForSeason(season, divisionId); const [teams, games, standings] = await Promise.all([this.seasonTeams(user, season, division.id), this.games(user, season, division.id), this.standings(user, season, division.id)]); return { teamCount: teams.length, upcoming: games.filter((g) => g.status === 'scheduled' && g.scheduled_at !== null && new Date(g.scheduled_at).getTime() >= Date.now()), recent: games.filter((g) => g.status === 'completed').reverse(), standings }; }
}
