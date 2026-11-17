import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

export type TrustedGateway = { peers: string[]; secret?: string };

// Reads the optional trusted-gateway settings that let the web gateway assert the real client IP.
export function trustedGateway(config: ConfigService): TrustedGateway {
  const peers = (config.get<string>('AUTH_TRUSTED_GATEWAY_IPS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const secret = config.get<string>('AUTH_GATEWAY_SECRET') || undefined;
  if (peers.some((ip) => !isIP(ip))) throw new Error('AUTH_TRUSTED_GATEWAY_IPS must contain IP addresses');
  if (!!secret !== (peers.length > 0) || (secret && Buffer.byteLength(secret) < 32)) {
    throw new Error('Configure both AUTH_GATEWAY_SECRET (at least 32 bytes) and AUTH_TRUSTED_GATEWAY_IPS');
  }
  return { peers, secret };
}

// Express trust proxy is disabled. Never use X-Forwarded-For supplied by a client.
export function clientIp(req: Request, gateway: TrustedGateway): string {
  const peer = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  const supplied = req.get('x-auth-gateway-secret') ?? '';
  const asserted = req.get('x-auth-client-ip') ?? '';
  if (gateway.secret && gateway.peers.includes(peer) && isIP(asserted)) {
    const expected = createHash('sha256').update(gateway.secret).digest();
    const given = createHash('sha256').update(supplied).digest();
    if (timingSafeEqual(expected, given)) return asserted.replace(/^::ffff:/, '');
  }
  return peer;
}

