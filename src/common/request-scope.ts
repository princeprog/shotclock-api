import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException, Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { clientIp, trustedGateway, type TrustedGateway } from './client-ip';

type RequestScope = { write: boolean; allowArchived: boolean; ip?: string };
const storage = new AsyncLocalStorage<RequestScope>();

// Records whether the request changes data, so ownership checks can keep archived leagues read-only, and the client IP for security events.
@Injectable()
export class RequestScopeMiddleware implements NestMiddleware {
  private readonly gateway: TrustedGateway;
  constructor(config: ConfigService) { this.gateway = trustedGateway(config); }
  use(req: Request, _res: Response, next: NextFunction) {
    storage.run({ write: !['GET', 'HEAD', 'OPTIONS'].includes(req.method), allowArchived: false, ip: clientIp(req, this.gateway) }, next);
  }
}

// Archive, restore and permanent deletion are the only changes allowed inside an archived scope.
export function allowArchived<T>(action: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  return storage.run({ write: current?.write ?? true, allowArchived: true, ip: current?.ip }, action);
}

export function ensureNotArchived(...archivedAt: (Date | string | null | undefined)[]) {
  const scope = storage.getStore();
  if (!scope?.write || scope.allowArchived) return;
  if (archivedAt.some(Boolean)) throw new ConflictException('This item is archived. Restore it to make changes.');
}

export function currentClientIp(): string | undefined {
  return storage.getStore()?.ip;
}

