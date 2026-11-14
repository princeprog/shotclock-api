import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

type RequestScope = { write: boolean; allowArchived: boolean };
const storage = new AsyncLocalStorage<RequestScope>();

// Records whether the request changes data, so ownership checks can keep archived leagues read-only.
@Injectable()
export class RequestScopeMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    storage.run({ write: !['GET', 'HEAD', 'OPTIONS'].includes(req.method), allowArchived: false }, next);
  }
}

// Archive, restore and permanent deletion are the only changes allowed inside an archived scope.
export function allowArchived<T>(action: () => Promise<T>): Promise<T> {
  return storage.run({ write: storage.getStore()?.write ?? true, allowArchived: true }, action);
}

export function ensureNotArchived(...archivedAt: (Date | string | null | undefined)[]) {
  const scope = storage.getStore();
  if (!scope?.write || scope.allowArchived) return;
  if (archivedAt.some(Boolean)) throw new ConflictException('This item is archived. Restore it to make changes.');
}

