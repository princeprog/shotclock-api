import { Controller, Get, type MessageEvent, NotFoundException, Param, ParseUUIDPipe, Query, Req, Sse, UseGuards, type PipeTransform } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { from, switchMap, type Observable } from 'rxjs';
import { clientIp, trustedGateway, type TrustedGateway } from '../common/client-ip';
import { isSlug } from '../league/slug';
import { LiveStreamService } from './live-stream.service';
import { DirectoryQueryDto, DivisionQueryDto, GamesQueryDto, UpcomingQueryDto } from './public.dto';
import { PublicRateLimitGuard } from './public-rate-limit.guard';
import { PublicService } from './public.service';

// An address that cannot be a slug is simply not found.
class SlugPipe implements PipeTransform<string, string> {
  transform(value: string) { if (!isSlug(value)) throw new NotFoundException(); return value; }
}
const notFoundUuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException() });
// The website server streams for all of its visitors; other callers get a few streams each.
const STREAMS_PER_CLIENT = 5;
const STREAMS_FOR_SITE = 2000;

@Controller('public')
@UseGuards(PublicRateLimitGuard)
export class PublicController {
  private readonly gateway: TrustedGateway;
  constructor(private readonly publicData: PublicService, private readonly liveStream: LiveStreamService, private readonly limits: PublicRateLimitGuard, config: ConfigService) {
    this.gateway = trustedGateway(config);
  }
  @Get('leagues') directory(@Query() query: DirectoryQueryDto) { return this.publicData.directory(query.search, query.page); }
  @Get('games/upcoming') upcoming(@Query() query: UpcomingQueryDto) { return this.publicData.upcoming(query.limit); }
  @Get('leagues/:league') league(@Param('league', SlugPipe) league: string) { return this.publicData.league(league); }
  @Get('leagues/:league/seasons/:season') season(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string) { return this.publicData.season(league, season); }
  @Get('leagues/:league/seasons/:season/games') games(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: GamesQueryDto) { return this.publicData.games(league, season, query.division, query.team, query.view); }
  @Get('leagues/:league/seasons/:season/standings') standings(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.standings(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/stats') stats(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.stats(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/teams') teams(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Query() query: DivisionQueryDto) { return this.publicData.teams(league, season, query.division); }
  @Get('leagues/:league/seasons/:season/teams/:team') team(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Param('team', notFoundUuid) team: string) { return this.publicData.team(league, season, team); }
  @Get('leagues/:league/seasons/:season/games/:game') game(@Param('league', SlugPipe) league: string, @Param('season', SlugPipe) season: string, @Param('game', notFoundUuid) game: string) { return this.publicData.game(league, season, game); }
  // Server-Sent Events: the game's state now and after every change while it is live.
  @Sse('games/:id/live') live(@Param('id', notFoundUuid) id: string, @Req() req: Request): Observable<MessageEvent> {
    const site = this.limits.isSite(req.get('x-shotclock-site-key'));
    return from(this.publicData.publishedGame(id)).pipe(switchMap(() => this.liveStream.stream(id, site ? 'site' : `ip:${clientIp(req, this.gateway)}`, site ? STREAMS_FOR_SITE : STREAMS_PER_CLIENT)));
  }
}
