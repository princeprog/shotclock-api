import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, trustedGateway, type TrustedGateway } from '../common/client-ip';

const WINDOW_SECONDS = 60;

function positive(config: ConfigService, key: string, fallback: number) {
  const value = Number(config.get<string>(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

// The website server shares one budget identified by PUBLIC_SITE_KEY; other callers are limited per IP.
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly gateway: TrustedGateway;
  private readonly siteKey?: Buffer;
  private readonly siteLimit: number;
  private readonly anonymousLimit: number;
  constructor(private readonly counters: RateLimitService, config: ConfigService) {
    this.gateway = trustedGateway(config);
    const key = config.get<string>('PUBLIC_SITE_KEY') || undefined;
    if (key && Buffer.byteLength(key) < 32) throw new Error('PUBLIC_SITE_KEY must be at least 32 bytes');
    this.siteKey = key ? digest(key) : undefined;
    this.siteLimit = positive(config, 'PUBLIC_RATE_LIMIT_SITE', 3000);
    this.anonymousLimit = positive(config, 'PUBLIC_RATE_LIMIT_ANONYMOUS', 120);
  }

  isSite(supplied: string | undefined) {
    return !!(this.siteKey && supplied && timingSafeEqual(this.siteKey, digest(supplied)));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (this.isSite(req.get('x-shotclock-site-key'))) await this.counters.enforce('public:site', this.siteLimit, WINDOW_SECONDS);
    else await this.counters.enforce(`public:ip:${clientIp(req, this.gateway)}`, this.anonymousLimit, WINDOW_SECONDS);
    return true;
  }
}
