import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { LeagueRateLimitGuard } from './league-rate-limit.guard';
import { InvitationDto, InvitationTokenDto } from './league.dto';
import { ScorekeepersService } from './scorekeepers.service';

@Controller('league')
@UseGuards(LeagueRateLimitGuard)
export class ScorekeepersController {
  constructor(private readonly auth: AuthService, private readonly scorekeepers: ScorekeepersService) {}
  private async user(header?: string) { return (await this.auth.me(header)).user.id; }
  @Get('leagues/:id/scorekeepers') async list(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.scorekeepers.list(await this.user(h), id); }
  @Post('leagues/:id/invitations') async invite(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvitationDto) { return this.scorekeepers.invite(await this.user(h), id, dto.email); }
  @Delete('invitations/:id') async revoke(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.scorekeepers.revoke(await this.user(h), id); }
  @Delete('league-members/:id') async remove(@Headers('authorization') h: string, @Param('id', ParseUUIDPipe) id: string) { return this.scorekeepers.removeMember(await this.user(h), id); }
  @Post('invitations/accept') async accept(@Headers('authorization') h: string, @Body() dto: InvitationTokenDto) { return this.scorekeepers.accept((await this.auth.me(h)).user, dto.token); }
  @Get('scorekeeping/games') async games(@Headers('authorization') h: string) { return this.scorekeepers.scorekeeping(await this.user(h)); }
}

