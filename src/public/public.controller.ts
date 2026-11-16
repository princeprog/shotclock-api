import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards, type PipeTransform } from '@nestjs/common';
import { isSlug } from '../league/slug';
import { DirectoryQueryDto, DivisionQueryDto, GamesQueryDto, UpcomingQueryDto } from './public.dto';
import { PublicRateLimitGuard } from './public-rate-limit.guard';
import { PublicService } from './public.service';

// An address that cannot be a slug is simply not found.
class SlugPipe implements PipeTransform<string, string> {
  transform(value: string) { if (!isSlug(value)) throw new NotFoundException(); return value; }
}
const notFoundUuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException() });

@Controller('public')
@UseGuards(PublicRateLimitGuard)
export class PublicController {
  constructor(private readonly publicData: PublicService) {}
  @Get('leagues') directory(@Query() query: DirectoryQueryDto) { return this.publicData.directory(query.search, query.page); }
  @Get('games/upcoming') upcoming(@Query() query: UpcomingQueryDto) { return this.publicData.upcoming(query.limit); }
  @Get('leagues/:league') league(@Param('league', SlugPipe) league: string) { return this.publicData.league(league); }
  @Get('leagues/:league/seasons/:season') season(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string) { return this.publicData.season(league, season); }
  @Get('leagues/:league/seasons/:season/games') games(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: GamesQueryDto) { return this.publicData.games(league, season, query.division, query.team, query.view); }
  @Get('leagues/:league/seasons/:season/standings') standings(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.standings(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/stats') stats(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.stats(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/teams') teams(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.teams(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/teams/:team') team(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Param('team', notFoundUuid) team: string) { return this.publicData.team(league, season, team); }
}
