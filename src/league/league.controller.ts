import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { CreateTeamDto, MoveTeamRegistrationDto, DivisionDto, DivisionFilterDto, PlayerDto, UpdateDivisionDto, UpdatePlayerDto, GameDto, GameFilterDto, JerseyDto, LeagueDto, NameDto, OrganizationSeasonFilterDto, OrganizationTeamFilterDto, OrganizationVenueFilterDto, RosterDto, RosterFilterDto, ScoreDto, SeasonDto, SeasonFilterDto, StatusDto, TeamDto, TeamRegistrationDto, VenueDto } from './league.dto';
import { LeagueService } from './league.service';
import { ScheduleService } from './schedule.service';
import { ForfeitDto } from './forfeit.dto';
import { PlayoffSaveDto, ScheduleAvailabilityRequestDto, SchedulePreviewDto, ScheduleSaveDto } from './league.dto';

@Controller('league')
export class LeagueController {
  constructor(private readonly auth: AuthService, private readonly league: LeagueService, private readonly schedule: ScheduleService) {}
  private async user(header?: string) { return (await this.auth.me(header)).user.id; }
  @Get('organizations') async organizations(@Headers('authorization') h?: string) { return this.league.organizations(await this.user(h)); }
  @Post('organizations') async createOrganization(@Headers('authorization') h: string, @Body() dto: NameDto) { return this.league.createOrganization(await this.user(h), dto); }
  @Get('organizations/:id') async organization(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.getOrganization(await this.user(h), id); }
  @Patch('organizations/:id') async editOrganization(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NameDto) { return this.league.editOrganization(await this.user(h), id, dto); }
  @Get('organizations/:id/leagues') async leagues(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.leagues(await this.user(h), id); }
  @Get('organizations/:id/seasons') async organizationSeasons(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: OrganizationSeasonFilterDto) { return this.league.organizationSeasons(await this.user(h), id, filters); }
  @Get('organizations/:id/teams') async organizationTeams(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: OrganizationTeamFilterDto) { return this.league.organizationTeams(await this.user(h), id, filters); }
  @Get('organizations/:id/players') async players(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: RosterFilterDto) { return this.league.players(await this.user(h), id, filters); }
  @Post('organizations/:id/players') async createPlayer(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlayerDto) { return this.league.createPlayer(await this.user(h), id, dto); }
  @Post('organizations/:id/players/:playerId/fork') async forkPlayer(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Param('playerId', ParseUUIDPipe) playerId: string) { return this.league.forkPlayer(await this.user(h), id, playerId); }
  @Patch('players/:id') async editPlayer(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlayerDto) { return this.league.editPlayer(await this.user(h), id, dto); }
  @Get('organizations/:id/venues') async organizationVenues(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: OrganizationVenueFilterDto) { return this.league.organizationVenues(await this.user(h), id, filters); }
  @Get('organizations/:id/team-seasons') async organizationTeamSeasons(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.organizationTeamSeasons(await this.user(h), id); }
  @Post('organizations/:id/leagues') async createLeague(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeagueDto) { return this.league.createLeague(await this.user(h), id, dto); }
  @Get('leagues/:id') async getLeague(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.getLeague(await this.user(h), id); }
  @Patch('leagues/:id') async editLeague(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeagueDto) { return this.league.editLeague(await this.user(h), id, dto); }
  @Get('leagues/:id/seasons') async seasons(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: SeasonFilterDto) { return this.league.seasons(await this.user(h), id, filters); }
  @Post('leagues/:id/seasons') async createSeason(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SeasonDto) { return this.league.createSeason(await this.user(h), id, dto); }
  @Get('seasons/:id') async season(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.getSeason(await this.user(h), id); }
  @Patch('seasons/:id') async editSeason(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SeasonDto) { return this.league.editSeason(await this.user(h), id, dto); }
  @Get('seasons/:id/divisions') async divisions(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.divisions(await this.user(h), id); }
  @Post('seasons/:id/divisions') async createDivision(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DivisionDto) { return this.league.createDivision(await this.user(h), id, dto); }
  @Patch('divisions/:id') async editDivision(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDivisionDto) { return this.league.editDivision(await this.user(h), id, dto); }
  @Delete('divisions/:id') async deleteDivision(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.deleteDivision(await this.user(h), id); }
  @Get('divisions/:id/schedule/status') async scheduleStatus(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.schedule.status(await this.user(h), id); }
  @Post('divisions/:id/schedule/preview') async previewSchedule(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SchedulePreviewDto) { return this.schedule.preview(await this.user(h), id, dto); }
  @Post('divisions/:id/schedule') async saveSchedule(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleSaveDto) { return this.schedule.save(await this.user(h), id, dto); }
  @Post('divisions/:id/playoffs/preview') async previewPlayoffs(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleAvailabilityRequestDto) { return this.schedule.previewPlayoffs(await this.user(h), id, dto); }
  @Post('divisions/:id/playoffs') async savePlayoffs(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlayoffSaveDto) { return this.schedule.savePlayoffs(await this.user(h), id, dto); }
  @Post('seasons/:id/status') async status(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) { return this.league.transition(await this.user(h), id, dto.status); }
  @Get('leagues/:id/teams') async teams(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.teams(await this.user(h), id); }
  @Post('leagues/:id/teams') async createTeam(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTeamDto) { return this.league.createTeam(await this.user(h), id, dto); }
  @Get('teams/:id') async team(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.getTeam(await this.user(h), id); }
  @Patch('teams/:id') async editTeam(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TeamDto) { return this.league.editTeam(await this.user(h), id, dto); }
  @Get('seasons/:id/teams') async seasonTeams(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: DivisionFilterDto) { return this.league.seasonTeams(await this.user(h), id, filters.divisionId); }
  @Post('seasons/:id/teams') async registerTeam(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TeamRegistrationDto) { return this.league.registerTeam(await this.user(h), id, dto.teamId, dto.divisionId); }
  @Get('season-teams/:id') async seasonTeam(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.getSeasonTeam(await this.user(h), id); }
  @Patch('season-teams/:id') async moveTeamRegistration(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveTeamRegistrationDto) { return this.league.moveTeamRegistration(await this.user(h), id, dto.divisionId); }
  @Delete('season-teams/:id') async removeTeamRegistration(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.removeTeamRegistration(await this.user(h), id); }
  @Get('season-teams/:id/roster') async roster(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: RosterFilterDto) { return this.league.roster(await this.user(h), id, filters); }
  @Post('season-teams/:id/roster') async addPlayer(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RosterDto) { return this.league.addPlayer(await this.user(h), id, dto); }
  @Patch('rosters/:id') async jersey(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JerseyDto) { return this.league.editJersey(await this.user(h), id, dto); }
  @Delete('rosters/:id') async removeRosterRegistration(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.removeRosterRegistration(await this.user(h), id); }
  @Get('leagues/:id/venues') async venues(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.venues(await this.user(h), id); }
  @Post('leagues/:id/venues') async createVenue(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VenueDto) { return this.league.createVenue(await this.user(h), id, dto); }
  @Patch('venues/:id') async editVenue(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VenueDto) { return this.league.editVenue(await this.user(h), id, dto); }
  @Get('seasons/:id/games') async games(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: GameFilterDto) { const user = await this.user(h); const { divisionId, ...other } = filters; return Object.values(other).some((value) => value !== undefined) ? this.league.filteredGames(user, id, filters) : this.league.games(user, id, divisionId); }
  @Post('seasons/:id/games') async createGame(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GameDto) { return this.league.createGame(await this.user(h), id, dto); }
  @Patch('games/:id') async editGame(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GameDto) { return this.league.editGame(await this.user(h), id, dto); }
  @Get('games/:id/schedule-history') async scheduleHistory(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.league.scheduleHistory(await this.user(h), id); }
  @Delete('games/:id') async deleteGame(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.schedule.remove(await this.user(h), id); }
  @Post('games/:id/score') async score(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScoreDto) { return this.league.score(await this.user(h), id, dto); }
  @Post('games/:id/forfeit') async forfeit(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ForfeitDto) { return this.league.forfeit(await this.user(h), id, dto); }
  @Get('seasons/:id/standings') async standings(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: DivisionFilterDto) { return this.league.standings(await this.user(h), id, filters.divisionId); }
  @Get('seasons/:id/dashboard') async dashboard(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Query() filters: DivisionFilterDto) { return this.league.dashboard(await this.user(h), id, filters.divisionId); }
}
