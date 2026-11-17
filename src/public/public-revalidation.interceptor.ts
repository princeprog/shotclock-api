import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { from, switchMap, tap, type Observable } from 'rxjs';
import { WebsiteRevalidationService } from './website-revalidation.service';

// After a successful league change, refreshes the affected public pages without delaying or failing the response.
@Injectable()
export class PublicRevalidationInterceptor implements NestInterceptor {
  constructor(private readonly website: WebsiteRevalidationService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.website.enabled || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next.handle();
    return from(this.website.snapshot(req.method, req.path)).pipe(
      switchMap((before) => next.handle().pipe(tap(() => { void this.website.afterWrite(before); }))),
    );
  }
}
