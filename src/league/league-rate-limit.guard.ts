import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, trustedGateway, type TrustedGateway } from '../common/client-ip';

export type LeagueLimits = { read: number; write: number; schedule: number; anonymous: number };
const WINDOW_SECONDS = 60;
// Schedule planning and saving can do heavy work, so they get the tightest budget.
const SCHEDULE_ROUTE = /\/(schedule|playoffs)(\/(preview|estimate|suggest|validate|calendar))?$/;

export function leagueBucket(method: string, path: string, authenticated: boolean, limits: LeagueLimits): [string, number] {
  if (!authenticated) return ['anonymous', limits.anonymous];
  if (method !== 'GET' && SCHEDULE_ROUTE.test(path)) return ['schedule', limits.schedule];
  if (method === 'GET' || method === 'HEAD') return ['read', limits.read];
  return ['write', limits.write];
}

function positive(config: ConfigService, key: string, fallback: number) {
  const value = Number(config.get<string>(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

// Per-user limits for league requests. Only the token signature is checked here; the handler still validates the session.
@Injectable()
export class LeagueRateLimitGuard implements CanActivate {
  private readonly gateway: TrustedGateway;
  private readonly limits: LeagueLimits;
  constructor(private readonly counters: RateLimitService, private readonly auth: AuthService, config: ConfigService) {
    this.gateway = trustedGateway(config);
    this.limits = { read: positive(config, 'LEAGUE_RATE_LIMIT_READ', 300), write: positive(config, 'LEAGUE_RATE_LIMIT_WRITE', 60), schedule: positive(config, 'LEAGUE_RATE_LIMIT_SCHEDULE', 20), anonymous: positive(config, 'LEAGUE_RATE_LIMIT_ANONYMOUS', 60) };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = await this.auth.accessTokenUser(req.get('authorization'));
    const [bucket, limit] = leagueBucket(req.method, req.path, !!user, this.limits);
    await this.counters.enforce(`league:${bucket}:${user ? `user:${user}` : `ip:${clientIp(req, this.gateway)}`}`, limit, WINDOW_SECONDS);
    return true;
  }
}

