import { HttpException, Injectable, Logger, type MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Observable, Subject } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { databaseSsl } from '../database/database-ssl';
import { liveSnapshot } from '../league/live-snapshot';

type Snapshot = Awaited<ReturnType<typeof liveSnapshot>>;
const TOTAL_STREAMS = 2000;
const HEARTBEAT_MS = 25_000;
const CLOSE_AFTER_FINAL_MS = 60_000;
const COALESCE_MS = 250;

// Pushes live game updates to viewers. Live scoring notifies Postgres after each change, so every API instance
// hears it on one listening connection, reads the game once and sends it to that game's viewers.
@Injectable()
export class LiveStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveStreamService.name);
  private client?: Client;
  private stopped = false;
  private retryMs = 1000;
  private readonly games = new Map<string, Subject<Snapshot>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly perClient = new Map<string, number>();
  private total = 0;
  constructor(private readonly database: DatabaseService, private readonly config: ConfigService) {}

  onModuleInit() { void this.listen(); }
  async onModuleDestroy() {
    this.stopped = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    await this.client?.end().catch(() => {});
  }

  private async listen() {
    if (this.stopped) return;
    const client = new Client({ host: this.config.getOrThrow<string>('DB_HOST'), port: Number(this.config.getOrThrow<string>('DB_PORT')), user: this.config.getOrThrow<string>('DB_USER'),
      password: this.config.getOrThrow<string>('DB_PASSWORD'), database: this.config.getOrThrow<string>('DB_NAME'), ssl: databaseSsl({ get: (key) => this.config.get<string>(key) }) });
    client.on('error', () => this.reconnect(client));
    client.on('notification', (message) => { if (message.channel === 'game_live' && message.payload) this.changed(message.payload); });
    try {
      await client.connect();
      await client.query('LISTEN game_live');
      this.client = client;
      this.retryMs = 1000;
    } catch {
      this.reconnect(client);
    }
  }
  private reconnect(client: Client) {
    if (this.client === client) this.client = undefined;
    void client.end().catch(() => {});
    if (this.stopped) return;
    this.logger.warn('Live game updates paused; reconnecting to PostgreSQL');
    setTimeout(() => void this.listen(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
  // Changes to one game that arrive close together are read and sent once.
  private changed(gameId: string) {
    if (!this.games.has(gameId) || this.pending.has(gameId)) return;
    this.pending.set(gameId, setTimeout(() => { this.pending.delete(gameId); void this.publish(gameId); }, COALESCE_MS));
  }
  private async publish(gameId: string) {
    const subject = this.games.get(gameId);
    if (!subject) return;
    try { subject.next(await liveSnapshot(this.database.db, gameId, false)); }
    catch (error) { this.logger.warn(`Could not read live game ${gameId}: ${String(error)}`); }
  }

  // Sends the game now and after every change, with a keep-alive, and closes a minute after the game is final.
  stream(gameId: string, clientKey: string, clientLimit: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const open = this.perClient.get(clientKey) ?? 0;
      if (this.total >= TOTAL_STREAMS || open >= clientLimit) { subscriber.error(new HttpException('Too many live connections', 429)); return; }
      this.total += 1;
      this.perClient.set(clientKey, open + 1);
      let subject = this.games.get(gameId);
      if (!subject) { subject = new Subject<Snapshot>(); this.games.set(gameId, subject); }
      const updates = subject;
      let closeTimer: NodeJS.Timeout | undefined;
      const send = (snapshot: Snapshot) => {
        subscriber.next({ type: 'snapshot', data: snapshot });
        if (snapshot.status === 'completed' && !closeTimer) closeTimer = setTimeout(() => subscriber.complete(), CLOSE_AFTER_FINAL_MS);
      };
      const subscription = updates.subscribe(send);
      const heartbeat = setInterval(() => subscriber.next({ type: 'ping', data: '' }), HEARTBEAT_MS);
      liveSnapshot(this.database.db, gameId, false).then(send, (error: unknown) => subscriber.error(error));
      return () => {
        subscription.unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(closeTimer);
        this.total -= 1;
        const remaining = (this.perClient.get(clientKey) ?? 1) - 1;
        if (remaining) this.perClient.set(clientKey, remaining); else this.perClient.delete(clientKey);
        if (!updates.observed) this.games.delete(gameId);
      };
    });
  }
}

