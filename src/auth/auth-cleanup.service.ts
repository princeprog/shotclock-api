import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthCleanup.name);
  private timer?: NodeJS.Timeout;
  constructor(private readonly database: DatabaseService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => this.logger.error('Authentication cleanup failed'));
    }, 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async cleanup() {
    const now = new Date();
    await this.database.db.deleteFrom('auth.sessions')
      .where((eb) => eb.or([eb('idle_expires_at', '<=', now), eb('absolute_expires_at', '<=', now)])).execute();
    await this.database.db.deleteFrom('auth.action_tokens').where('expires_at', '<=', now).execute();
    await this.database.db.deleteFrom('auth.rate_limits')
      .where('window_start', '<=', new Date(now.getTime() - 24 * 60 * 60_000)).execute();
  }
}
