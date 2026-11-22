import { Body, Controller, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, trustedGateway, type TrustedGateway } from '../common/client-ip';
import { InvitationTokenDto } from './league.dto';
import { ScorekeepersService } from './scorekeepers.service';

// Invitation links are opened before sign-in, so the lookup needs no session and is limited per client IP.
@Controller('invitations')
export class InvitationsController {
  private readonly gateway: TrustedGateway;
  constructor(private readonly scorekeepers: ScorekeepersService, private readonly limits: RateLimitService, config: ConfigService) {
    this.gateway = trustedGateway(config);
  }
  @Post('lookup') async lookup(@Req() req: Request, @Body() dto: InvitationTokenDto) {
    await this.limits.enforce(`invitation-lookup:ip:${clientIp(req, this.gateway)}`, 30, 10 * 60);
    return this.scorekeepers.lookup(dto.token);
  }
}

