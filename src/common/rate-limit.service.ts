import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service';

// Fixed-window counters in PostgreSQL, shared by every API instance. Keys are hashed so they never store emails or IPs.
@Injectable()
export class RateLimitService {
  constructor(private readonly database: DatabaseService) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const digest = createHash('sha256').update(key).digest('hex');
    const result = await sql<{ count: number }>`
      INSERT INTO auth.rate_limits AS current_limit (key, window_start, count) VALUES (${digest}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN current_limit.window_start <= now() - make_interval(secs => ${windowSeconds})
          THEN 1 ELSE current_limit.count + 1 END,
        window_start = CASE WHEN current_limit.window_start <= now() - make_interval(secs => ${windowSeconds})
          THEN now() ELSE current_limit.window_start END
      RETURNING count
    `.execute(this.database.db);
    return result.rows[0].count <= limit;
  }

  async enforce(key: string, limit: number, windowSeconds: number) {
    if (!await this.consume(key, limit, windowSeconds)) throw new HttpException('Too many requests', 429);
  }
}

