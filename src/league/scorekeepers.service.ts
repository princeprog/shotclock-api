import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/db';
import { AuthMailer } from '../auth/auth-mailer.service';
import { RateLimitService } from '../common/rate-limit.service';
import { ensureNotArchived } from '../common/request-scope';
import { labelPending } from './bracket';

type Database = Kysely<DB> | Transaction<DB>;
const INVITATION_DAYS = 7;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Scorekeepers are invited by email to one league. They can score that league's games and nothing else.
@Injectable()
export class ScorekeepersService {
  constructor(private readonly database: DatabaseService, private readonly mailer: AuthMailer, private readonly limits: RateLimitService) {}
  private get db() { return this.database.db; }

  private async ownedLeague(user: string, leagueId: string, db: Database = this.db) {
    const league = await db.selectFrom('league.leagues as l').innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['l.id', 'l.name', 'l.archived_at', 'o.archived_at as organization_archived_at', 'o.name as organization_name'])
      .where('l.id', '=', leagueId).where('o.owner_user_id', '=', user).executeTakeFirst();
    if (!league) throw new NotFoundException();
    ensureNotArchived(league.archived_at, league.organization_archived_at);
    return league;
  }

  async list(user: string, leagueId: string) {
    await this.ownedLeague(user, leagueId);
    const [members, invitations] = await Promise.all([
      this.db.selectFrom('league.league_members as m').innerJoin('auth.users as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id as userId', 'u.email', 'u.name', 'm.created_at as createdAt'])
        .where('m.league_id', '=', leagueId).orderBy('u.email').execute(),
      this.db.selectFrom('league.invitations').select(['id', 'email', 'created_at as createdAt', 'expires_at as expiresAt'])
        .where('league_id', '=', leagueId).where('accepted_at', 'is', null).where('revoked_at', 'is', null).orderBy('email').execute(),
    ]);
    return { members, invitations };
  }

  // Inviting an address that already has a pending invitation sends a fresh link and restarts its expiry.
  async invite(user: string, leagueId: string, rawEmail: string) {
    await this.limits.enforce(`league-invite:${user}`, 20, 60 * 60);
    const email = rawEmail.trim().toLowerCase();
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
    const { invitation, league, inviter } = await this.db.transaction().execute(async (tx) => {
      const league = await this.ownedLeague(user, leagueId, tx);
      const inviter = await tx.selectFrom('auth.users').select(['email', 'name']).where('id', '=', user).executeTakeFirstOrThrow();
      if (inviter.email.toLowerCase() === email) throw new BadRequestException('You already manage this league');
      const member = await tx.selectFrom('league.league_members as m').innerJoin('auth.users as u', 'u.id', 'm.user_id').select('m.id')
        .where('m.league_id', '=', leagueId).where(sql<string>`lower(u.email)`, '=', email).executeTakeFirst();
      if (member) throw new ConflictException('This person already keeps score for this league');
      const pending = await tx.selectFrom('league.invitations').select('id').where('league_id', '=', leagueId).where('email', '=', email)
        .where('accepted_at', 'is', null).where('revoked_at', 'is', null).forUpdate().executeTakeFirst();
      const invitation = pending
        ? await tx.updateTable('league.invitations').set({ token_hash: hash(token), expires_at: expires, invited_by_user_id: user }).where('id', '=', pending.id)
          .returning(['id', 'email', 'created_at as createdAt', 'expires_at as expiresAt']).executeTakeFirstOrThrow()
        : await tx.insertInto('league.invitations').values({ league_id: leagueId, email, token_hash: hash(token), invited_by_user_id: user, expires_at: expires })
          .returning(['id', 'email', 'created_at as createdAt', 'expires_at as expiresAt']).executeTakeFirstOrThrow();
      return { invitation, league, inviter };
    });
    void this.mailer.sendInvitation(email, league.name, inviter.name?.trim() || inviter.email, token);
    return invitation;
  }

  async revoke(user: string, invitationId: string) {
    const invitation = await this.db.selectFrom('league.invitations').select(['id', 'league_id', 'accepted_at', 'revoked_at']).where('id', '=', invitationId).executeTakeFirst();
    if (!invitation) throw new NotFoundException();
    await this.ownedLeague(user, invitation.league_id);
    if (invitation.accepted_at || invitation.revoked_at) throw new ConflictException('This invitation is no longer pending');
    await this.db.updateTable('league.invitations').set({ revoked_at: new Date() }).where('id', '=', invitationId).execute();
    return { revoked: true };
  }

  async removeMember(user: string, memberId: string) {
    const member = await this.db.selectFrom('league.league_members').select(['id', 'league_id']).where('id', '=', memberId).executeTakeFirst();
    if (!member) throw new NotFoundException();
    await this.ownedLeague(user, member.league_id);
    await this.db.deleteFrom('league.league_members').where('id', '=', memberId).execute();
    return { removed: true };
  }

  private invitationByToken(token: string, db: Database = this.db) {
    return db.selectFrom('league.invitations as i').innerJoin('league.leagues as l', 'l.id', 'i.league_id').innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['i.id', 'i.league_id', 'i.email', 'i.expires_at', 'i.accepted_at', 'i.revoked_at', 'l.name as league_name', 'o.name as organization_name', 'l.archived_at', 'o.archived_at as organization_archived_at'])
      .where('i.token_hash', '=', hash(token));
  }
  private status(invitation: { expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; archived_at: Date | null; organization_archived_at: Date | null }) {
    if (invitation.accepted_at) return 'accepted' as const;
    if (invitation.revoked_at || invitation.archived_at || invitation.organization_archived_at) return 'revoked' as const;
    if (new Date(invitation.expires_at).getTime() <= Date.now()) return 'expired' as const;
    return 'pending' as const;
  }

  // Shown before sign-in so the invitee knows which league the link is for.
  async lookup(token: string) {
    const invitation = await this.invitationByToken(token).executeTakeFirst();
    if (!invitation) throw new NotFoundException();
    return { leagueName: invitation.league_name, organizationName: invitation.organization_name, email: invitation.email, status: this.status(invitation) };
  }

  async accept(user: { id: string; email: string; emailVerified: boolean }, token: string) {
    return this.db.transaction().execute(async (tx) => {
      const invitation = await this.invitationByToken(token, tx).forUpdate('i').executeTakeFirst();
      if (!invitation) throw new NotFoundException();
      const status = this.status(invitation);
      if (status === 'accepted') throw new ConflictException('This invitation was already accepted');
      if (status === 'revoked') throw new ConflictException('This invitation was cancelled. Ask the league owner for a new one.');
      if (status === 'expired') throw new ConflictException('This invitation has expired. Ask the league owner for a new one.');
      if (user.email.toLowerCase() !== invitation.email) throw new ConflictException(`This invitation was sent to ${invitation.email}. Sign in with that email to accept it.`);
      if (!user.emailVerified) throw new ConflictException('Verify your email before accepting the invitation');
      await tx.insertInto('league.league_members').values({ league_id: invitation.league_id, user_id: user.id, role: 'scorekeeper' })
        .onConflict((conflict) => conflict.columns(['league_id', 'user_id']).doNothing()).execute();
      await tx.updateTable('league.invitations').set({ accepted_at: new Date(), accepted_by_user_id: user.id }).where('id', '=', invitation.id).execute();
      return { leagueId: invitation.league_id, leagueName: invitation.league_name };
    });
  }

  // Leagues the user owns or keeps score for, with their live games and the next upcoming scheduled games from today on.
  async scorekeeping(user: string) {
    const owned = this.db.selectFrom('league.leagues as l').innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['l.id', 'l.name', 'l.time_zone', 'o.name as organization_name', sql<string>`'owner'`.as('role')])
      .where('o.owner_user_id', '=', user).where('l.archived_at', 'is', null).where('o.archived_at', 'is', null);
    const scored = this.db.selectFrom('league.league_members as m').innerJoin('league.leagues as l', 'l.id', 'm.league_id').innerJoin('league.organizations as o', 'o.id', 'l.organization_id')
      .select(['l.id', 'l.name', 'l.time_zone', 'o.name as organization_name', 'm.role'])
      .where('m.user_id', '=', user).where('l.archived_at', 'is', null).where('o.archived_at', 'is', null);
    const leagues = await owned.union(scored).orderBy('name').execute();
    if (!leagues.length) return { leagues: [], games: [] };
    const zone = sql<string>`coalesce(l.time_zone, 'UTC')`;
    const todayStart = sql<Date>`(date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
    const rows = await this.db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id').innerJoin('league.leagues as l', 'l.id', 's.league_id')
      .innerJoin('league.divisions as d', 'd.id', 'g.division_id')
      .leftJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').leftJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .leftJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').leftJoin('league.teams as at', 'at.id', 'a.team_id')
      .leftJoin('league.venues as v', 'v.id', 'g.venue_id')
      .selectAll('g').select(['ht.name as home_name', 'at.name as away_name', 'v.name as venue_name', 'd.name as division_name', 's.name as season_name', 'l.name as league_name', 'l.time_zone'])
      .where('l.id', 'in', leagues.map((league) => league.id)).where('s.status', '=', 'active').where('s.archived_at', 'is', null)
      .where((eb) => eb.or([
        eb('g.status', '=', 'live'),
        eb.and([eb('g.status', '=', 'scheduled'), eb('g.scheduled_at', '>=', todayStart)]),
      ]))
      .orderBy(sql`g.status = 'live'`, 'desc').orderBy('g.scheduled_at').orderBy('g.id').limit(50).execute();
    return { leagues, games: await labelPending(this.db, rows) };
  }
}

