import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { AuthMailer } from './auth-mailer.service';

const DAY = 86_400_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const normalizeEmail = (email: string) => email.trim().toLowerCase();
type User = { id: string; email: string; name: string | null; email_verified: boolean; password_hash: string };
type Session = { id: string; user_id: string; idle_expires_at: Date; absolute_expires_at: Date; revoked_at: Date | null; used_at: Date | null };
type Claims = { sub: string; sid: string; typ: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret: string;
  private readonly dummyHash = argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
  constructor(private readonly database: DatabaseService, private readonly jwt: JwtService,
    private readonly mailer: AuthMailer, config: ConfigService) {
    this.secret = config.getOrThrow<string>('AUTH_JWT_SECRET');
    if (Buffer.byteLength(this.secret) < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 bytes');
  }

  private publicUser(user: User) {
    return { id: user.id, email: user.email, name: user.name, emailVerified: user.email_verified };
  }

  private deliver(email: string, purpose: 'verify' | 'reset', raw: string) {
    void this.mailer.send(email, purpose, raw).catch(() => {
      this.logger.error('Failed to deliver an authentication email');
    });
  }

  private async issue(db: Kysely<DB> | Transaction<DB>, user: User) {
    const now = Date.now();
    const id = randomUUID();
    const refreshToken = token();
    await db.insertInto('auth.sessions').values({ id, user_id: user.id,
      idle_expires_at: new Date(now + 7 * DAY), absolute_expires_at: new Date(now + 30 * DAY) }).execute();
    await db.insertInto('auth.refresh_tokens').values({ token_hash: hash(refreshToken), session_id: id }).execute();
    return { accessToken: await this.sign(user.id, id), refreshToken, user: this.publicUser(user) };
  }

  private sign(userId: string, sessionId: string) {
    return this.jwt.signAsync({ sub: userId, sid: sessionId, typ: 'access' },
      { secret: this.secret, algorithm: 'HS256', expiresIn: '15m' });
  }

  async register(emailInput: string, password: string, name?: string) {
    const email = normalizeEmail(emailInput);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const result = await this.database.db.transaction().execute(async (tx) => {
      const user = await tx.insertInto('auth.users').values({
        id: randomUUID(), email, password_hash: passwordHash, name: name?.trim() || null,
      }).onConflict((oc) => oc.column('email').doNothing()).returningAll().executeTakeFirst();
      if (!user) return null;
      const verification = token();
      await tx.insertInto('auth.action_tokens').values({
        token_hash: hash(verification), user_id: user.id, purpose: 'verify', expires_at: new Date(Date.now() + DAY),
      }).execute();
      return { verification, email };
    });
    if (result) this.deliver(result.email, 'verify', result.verification);
    return { message: 'If the account is eligible, an email will be sent.' };
  }

  async login(emailInput: string, password: string) {
    const user = await this.database.db.selectFrom('auth.users').selectAll()
      .where('email', '=', normalizeEmail(emailInput)).executeTakeFirst();
    const valid = await argon2.verify(user?.password_hash ?? await this.dummyHash, password);
    if (!user || !valid || !user.email_verified) throw new UnauthorizedException('Invalid email or password');
    return this.database.db.transaction().execute(async (tx) => {
      const current = await tx.selectFrom('auth.users').selectAll().where('id', '=', user.id).forUpdate().executeTakeFirst();
      // A concurrent password reset must not create a session from old credentials.
      if (!current || !current.email_verified || current.password_hash !== user.password_hash) throw new UnauthorizedException('Invalid email or password');
      return this.issue(tx, current);
    });
  }

  async refresh(refreshToken: string) {
    const newToken = token();
    const result = await this.database.db.transaction().execute(async (tx) => {
      // Lock the session first so simultaneous refreshes and replays serialize.
      const row = await sql<Omit<Session, 'used_at'>>`SELECT s.id, s.user_id, s.idle_expires_at, s.absolute_expires_at,
        s.revoked_at FROM auth.refresh_tokens t JOIN auth.sessions s ON s.id = t.session_id
        WHERE t.token_hash = ${hash(refreshToken)} FOR UPDATE OF s`.execute(tx);
      const session = row.rows[0];
      if (!session) return null;
      // Re-read after acquiring the session lock: the first statement's snapshot
      // may predate another transaction that just rotated this token.
      const current = await tx.selectFrom('auth.refresh_tokens').select('used_at')
        .where('token_hash', '=', hash(refreshToken)).executeTakeFirstOrThrow();
      if (current.used_at) {
        await tx.updateTable('auth.sessions').set({ revoked_at: new Date() }).where('id', '=', session.id).execute();
        return null; // Commit revocation before throwing outside the transaction.
      }
      const now = new Date();
      if (session.revoked_at || session.idle_expires_at <= now || session.absolute_expires_at <= now) return null;
      await tx.updateTable('auth.refresh_tokens').set({ used_at: now }).where('token_hash', '=', hash(refreshToken)).execute();
      await tx.insertInto('auth.refresh_tokens').values({ token_hash: hash(newToken), session_id: session.id }).execute();
      await tx.updateTable('auth.sessions').set({
        idle_expires_at: new Date(Math.min(now.getTime() + 7 * DAY, session.absolute_expires_at.getTime())),
      }).where('id', '=', session.id).execute();
      const user = await tx.selectFrom('auth.users').selectAll().where('id', '=', session.user_id).executeTakeFirstOrThrow();
      return { accessToken: await this.sign(user.id, session.id), refreshToken: newToken, user: this.publicUser(user) };
    });
    if (!result) throw new UnauthorizedException('Invalid or expired refresh token');
    return result;
  }

  private async claims(authorization?: string): Promise<Claims> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException();
    try {
      const claims = await this.jwt.verifyAsync<Claims>(match[1], { secret: this.secret, algorithms: ['HS256'] });
      if (claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') throw new Error();
      return claims;
    } catch {
      throw new UnauthorizedException();
    }
  }

  async me(authorization?: string) {
    const claims = await this.claims(authorization);
    const now = new Date();
    const user = await this.database.db.selectFrom('auth.users as u')
      .innerJoin('auth.sessions as s', 's.user_id', 'u.id')
      .selectAll('u').where('u.id', '=', claims.sub).where('s.id', '=', claims.sid)
      .where('s.revoked_at', 'is', null).where('s.idle_expires_at', '>', now)
      .where('s.absolute_expires_at', '>', now).executeTakeFirst();
    if (!user) throw new UnauthorizedException();
    return { user: this.publicUser(user) };
  }

  async logout(authorization?: string, refreshToken?: string) {
    if (refreshToken) {
      await sql`UPDATE auth.sessions SET revoked_at = now() WHERE id IN
        (SELECT session_id FROM auth.refresh_tokens WHERE token_hash = ${hash(refreshToken)})`.execute(this.database.db);
      return;
    }
    const claims = await this.claims(authorization);
    await this.database.db.updateTable('auth.sessions').set({ revoked_at: new Date() })
      .where('id', '=', claims.sid).where('user_id', '=', claims.sub).execute();
  }

  async sendAction(emailInput: string, purpose: 'verify' | 'reset') {
    const email = normalizeEmail(emailInput);
    const result = await this.database.db.transaction().execute(async (tx) => {
      const user = await tx.selectFrom('auth.users').selectAll().where('email', '=', email).forUpdate().executeTakeFirst();
      if (!user || (purpose === 'verify' && user.email_verified)) return null;
      const raw = token();
      await tx.updateTable('auth.action_tokens').set({ used_at: new Date() })
        .where('user_id', '=', user.id).where('purpose', '=', purpose).where('used_at', 'is', null).execute();
      await tx.insertInto('auth.action_tokens').values({ token_hash: hash(raw), user_id: user.id, purpose,
        expires_at: new Date(Date.now() + (purpose === 'verify' ? DAY : 60 * 60_000)) }).execute();
      return raw;
    });
    if (result) this.deliver(email, purpose, result);
    return { message: 'If the account is eligible, an email will be sent.' };
  }

  async consumeAction(raw: string, purpose: 'verify' | 'reset', password?: string) {
    const passwordHash = password ? await argon2.hash(password, { type: argon2.argon2id }) : undefined;
    const success = await this.database.db.transaction().execute(async (tx) => {
      const candidate = await tx.selectFrom('auth.action_tokens').select('user_id')
        .where('token_hash', '=', hash(raw)).where('purpose', '=', purpose).executeTakeFirst();
      if (!candidate) return false;
      // Keep the same user-then-token lock order as sendAction.
      await tx.selectFrom('auth.users').select('id').where('id', '=', candidate.user_id).forUpdate().executeTakeFirst();
      const action = await tx.selectFrom('auth.action_tokens').selectAll()
        .where('token_hash', '=', hash(raw)).where('purpose', '=', purpose).forUpdate().executeTakeFirst();
      if (!action || action.used_at || action.expires_at <= new Date()) return false;
      await tx.updateTable('auth.action_tokens').set({ used_at: new Date() })
        .where('user_id', '=', action.user_id).where('purpose', '=', purpose).where('used_at', 'is', null).execute();
      if (purpose === 'verify') {
        await tx.updateTable('auth.users').set({ email_verified: true, updated_at: new Date() })
          .where('id', '=', action.user_id).execute();
      } else {
        await tx.updateTable('auth.users').set({ password_hash: passwordHash!, updated_at: new Date() })
          .where('id', '=', action.user_id).execute();
        await tx.updateTable('auth.sessions').set({ revoked_at: new Date() }).where('user_id', '=', action.user_id).execute();
      }
      return true;
    });
    if (!success) throw new BadRequestException('Invalid or expired token');
    return { message: purpose === 'verify' ? 'Email verified.' : 'Password reset.' };
  }
}
