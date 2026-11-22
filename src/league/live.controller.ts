import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { PublicRevalidationInterceptor } from '../public/public-revalidation.interceptor';
import { LeagueRateLimitGuard } from './league-rate-limit.guard';
import { LiveClockDto, LiveDeviceDto, LiveEventsDto, LiveStartDto } from './league.dto';
import { LiveService } from './live.service';

@Controller('league/games/:id/live')
@UseGuards(LeagueRateLimitGuard)
@UseInterceptors(PublicRevalidationInterceptor)
export class LiveController {
  constructor(private readonly auth: AuthService, private readonly live: LiveService) {}
  private async user(header?: string) { return (await this.auth.me(header)).user.id; }
  @Get() async get(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.live.get(await this.user(h), id); }
  @Post('start') async start(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveStartDto) { return this.live.start(await this.user(h), id, dto); }
  @Post('claim') async claim(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveDeviceDto) { return this.live.claim(await this.user(h), id, dto.deviceId); }
  @Post('events') async events(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveEventsDto) { return this.live.record(await this.user(h), id, dto.deviceId, dto.events); }
  @Post('events/:eventId/void') async undo(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Param('eventId', ParseUUIDPipe) eventId: string, @Body() dto: LiveDeviceDto) { return this.live.undo(await this.user(h), id, dto.deviceId, eventId); }
  @Post('clock') async clock(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveClockDto) { return this.live.clock(await this.user(h), id, dto); }
  @Post('period') async period(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveDeviceDto) { return this.live.nextPeriod(await this.user(h), id, dto.deviceId); }
  @Post('finish') async finish(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LiveDeviceDto) { return this.live.finish(await this.user(h), id, dto.deviceId); }
  @Post('reopen') async reopen(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.live.reopen(await this.user(h), id); }
}

