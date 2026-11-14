import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { currentClientIp } from './request-scope';

export type SecurityEvent =
  | 'login_succeeded' | 'login_failed' | 'password_changed' | 'password_reset' | 'email_change_requested' | 'email_changed'
  | 'other_sessions_revoked' | 'account_deleted'
  | 'organization_archived' | 'organization_restored' | 'organization_deleted'
  | 'league_archived' | 'league_restored' | 'league_deleted'
  | 'season_archived' | 'season_restored' | 'season_deleted' | 'season_returned_to_draft'
  | 'team_deleted' | 'player_deleted' | 'venue_deleted';

// An append-only record of sensitive account and data changes. Metadata holds IDs and names only, never secrets.
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);
  constructor(private readonly database: DatabaseService) {}

  async record(event: SecurityEvent, { userId = null, metadata = {} }: { userId?: string | null; metadata?: Record<string, unknown> } = {}) {
    try {
      await this.database.db.insertInto('auth.security_events').values({ event, user_id: userId, ip: currentClientIp() ?? null, metadata: JSON.stringify(metadata) }).execute();
    } catch {
      // Auditing must not break the action that already succeeded.
      this.logger.error(`Failed to record security event ${event}`);
    }
  }
}

