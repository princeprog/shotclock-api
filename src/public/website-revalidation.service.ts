import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

// Path prefixes under /league whose ID identifies one or more leagues. Rosters and players never appear publicly.
type Resource = 'organizations' | 'leagues' | 'seasons' | 'divisions' | 'teams' | 'season-teams' | 'venues' | 'games';
const RESOURCES = new Set<string>(['organizations', 'leagues', 'seasons', 'divisions', 'teams', 'season-teams', 'venues', 'games']);
// Schedule planning requests only compute previews and change nothing.
const DIAGNOSTIC_ROUTE = /\/(preview|estimate|validate|suggest|calendar)$/;
const ROUTE = /^\/league\/([a-z-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export type Snapshot = { leagueIds: string[]; slugs: string[] };

export function routeResource(method: string, path: string): { resource: Resource; id: string } | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method) || DIAGNOSTIC_ROUTE.test(path)) return null;
  const match = ROUTE.exec(path);
  if (!match || !RESOURCES.has(match[1])) return null;
  return { resource: match[1] as Resource, id: match[2].toLowerCase() };
}

export function revalidationTags(slugs: string[]) {
  const unique = [...new Set(slugs)];
  return unique.length ? ['directory', ...unique.map((slug) => `league:${slug}`)] : [];
}

// Tells the public website which cached league pages to refresh after an organizer changes data.
@Injectable()
export class WebsiteRevalidationService {
  private readonly logger = new Logger(WebsiteRevalidationService.name);
  private readonly url?: string;
  private readonly secret?: string;
  constructor(private readonly database: DatabaseService, config: ConfigService) {
    const url = config.get<string>('WEBSITE_REVALIDATE_URL') || undefined;
    const secret = config.get<string>('WEBSITE_REVALIDATE_SECRET') || undefined;
    if (!url) return;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || (config.get<string>('NODE_ENV') === 'production' && parsed.protocol !== 'https:')) throw new Error('WEBSITE_REVALIDATE_URL must be an HTTP(S) URL, using HTTPS in production');
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('WEBSITE_REVALIDATE_SECRET must be at least 32 bytes when WEBSITE_REVALIDATE_URL is set');
    this.url = url;
    this.secret = secret;
  }

  get enabled() { return !!this.url; }

  private get db() { return this.database.db; }

  private async leagueIds(resource: Resource, id: string): Promise<string[]> {
    const db = this.db;
    switch (resource) {
      case 'organizations': return (await db.selectFrom('league.leagues').select('id').where('organization_id', '=', id).execute()).map((row) => row.id);
      case 'leagues': return [id];
      case 'seasons': return (await db.selectFrom('league.seasons').select('league_id').where('id', '=', id).execute()).map((row) => row.league_id);
      case 'divisions': return (await db.selectFrom('league.divisions as d').innerJoin('league.seasons as s', 's.id', 'd.season_id').select('s.league_id').where('d.id', '=', id).execute()).map((row) => row.league_id);
      case 'teams': return (await db.selectFrom('league.teams').select('league_id').where('id', '=', id).execute()).map((row) => row.league_id);
      case 'season-teams': return (await db.selectFrom('league.season_teams').select('league_id').where('id', '=', id).execute()).map((row) => row.league_id);
      case 'venues': return (await db.selectFrom('league.venues').select('league_id').where('id', '=', id).execute()).map((row) => row.league_id);
      case 'games': return (await db.selectFrom('league.games as g').innerJoin('league.seasons as s', 's.id', 'g.season_id').select('s.league_id').where('g.id', '=', id).execute()).map((row) => row.league_id);
    }
  }

  // Published leagues, archived or not, so archiving or deleting a league also clears its pages.
  private async publishedSlugs(leagueIds: string[]) {
    if (!leagueIds.length) return [];
    const rows = await this.db.selectFrom('league.leagues').select('slug').where('id', 'in', leagueIds).where('published_at', 'is not', null).where('slug', 'is not', null).execute();
    return rows.map((row) => row.slug!);
  }

  // Taken before the write runs, so deleted records and old web addresses are still known.
  async snapshot(method: string, path: string): Promise<Snapshot | null> {
    const route = routeResource(method, path);
    if (!this.enabled || !route) return null;
    try {
      const leagueIds = await this.leagueIds(route.resource, route.id);
      return { leagueIds, slugs: await this.publishedSlugs(leagueIds) };
    } catch (error) {
      this.logger.warn(`Could not read leagues before a change: ${String(error)}`);
      return null;
    }
  }

  async afterWrite(before: Snapshot | null) {
    if (!before?.leagueIds.length) return;
    try {
      const tags = revalidationTags([...before.slugs, ...await this.publishedSlugs(before.leagueIds)]);
      if (tags.length) await this.send(tags);
    } catch (error) {
      this.logger.warn(`Website refresh failed: ${String(error)}`);
    }
  }

  async send(tags: string[]) {
    if (!this.url || !this.secret) return;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) this.logger.warn(`Website refresh returned ${response.status}`);
  }
}
