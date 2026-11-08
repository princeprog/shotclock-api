import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'kysely';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly trustedPeers: string[];
  private readonly gatewaySecret?: string;
  private readonly ipLimit: number;
  constructor(private readonly database: DatabaseService, config: ConfigService) {
    this.trustedPeers = (config.get<string>('AUTH_TRUSTED_GATEWAY_IPS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    this.gatewaySecret = config.get<string>('AUTH_GATEWAY_SECRET') || undefined;
    this.ipLimit = Number(config.get<string>('AUTH_RATE_LIMIT_IP') ?? 100);
    if (!Number.isSafeInteger(this.ipLimit) || this.ipLimit < 1) throw new Error('AUTH_RATE_LIMIT_IP must be a positive integer');
    if (this.trustedPeers.some((ip) => !isIP(ip))) throw new Error('AUTH_TRUSTED_GATEWAY_IPS must contain IP addresses');
    if (!!this.gatewaySecret !== (this.trustedPeers.length > 0) ||
      (this.gatewaySecret && Buffer.byteLength(this.gatewaySecret) < 32)) {
      throw new Error('Configure both AUTH_GATEWAY_SECRET (at least 32 bytes) and AUTH_TRUSTED_GATEWAY_IPS');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // Express trust proxy is disabled. Never use X-Forwarded-For supplied by a client.
    const peer = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    let client = peer;
    const supplied = req.get('x-auth-gateway-secret') ?? '';
    const assertedIp = req.get('x-auth-client-ip') ?? '';
    if (this.gatewaySecret && this.trustedPeers.includes(peer) && isIP(assertedIp)) {
      const expectedHash = createHash('sha256').update(this.gatewaySecret).digest();
      const suppliedHash = createHash('sha256').update(supplied).digest();
      if (timingSafeEqual(expectedHash, suppliedHash)) client = assertedIp.replace(/^::ffff:/, '');
    }
    const route = req.path;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const keys = [`ip:${route}:${client}`];
    if (email) keys.push(`account:${route}:${email}`);
    for (const key of keys) {
      const digest = createHash('sha256').update(key).digest('hex');
      const result = await sql<{ count: number }>`
        INSERT INTO auth.rate_limits AS current_limit (key, window_start, count) VALUES (${digest}, now(), 1)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN current_limit.window_start <= now() - interval '15 minutes'
            THEN 1 ELSE current_limit.count + 1 END,
          window_start = CASE WHEN current_limit.window_start <= now() - interval '15 minutes'
            THEN now() ELSE current_limit.window_start END
        RETURNING count
      `.execute(this.database.db);
      if (result.rows[0].count > (key.startsWith('ip:') ? this.ipLimit : 10)) {
        throw new HttpException('Too many requests', 429);
      }
    }
    return true;
  }
}
