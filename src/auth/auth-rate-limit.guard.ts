import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, trustedGateway, type TrustedGateway } from '../common/client-ip';

const WINDOW_SECONDS = 15 * 60;

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly gateway: TrustedGateway;
  private readonly ipLimit: number;
  constructor(private readonly limits: RateLimitService, config: ConfigService) {
    this.gateway = trustedGateway(config);
    this.ipLimit = Number(config.get<string>('AUTH_RATE_LIMIT_IP') ?? 100);
    if (!Number.isSafeInteger(this.ipLimit) || this.ipLimit < 1) throw new Error('AUTH_RATE_LIMIT_IP must be a positive integer');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const route = req.path;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    await this.limits.enforce(`ip:${route}:${clientIp(req, this.gateway)}`, this.ipLimit, WINDOW_SECONDS);
    if (email) await this.limits.enforce(`account:${route}:${email}`, 10, WINDOW_SECONDS);
    return true;
  }
}

