import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/db';

export type BracketOutcome = 'winner' | 'loser';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A schedule side is a season team, or in a playoff draft the winner or loser of a semifinal that is not played yet.
// A slot names a semifinal in the same draft ("<division>:semifinal-1:winner") or one already saved ("<game>:winner").
export const TEAM_OR_SLOT = new RegExp(`^${UUID}(?::semifinal-[12]:(?:winner|loser)|:(?:winner|loser))?$`, 'i');
const SLOT = new RegExp(`^(${UUID}):semifinal-([12]):(winner|loser)$`, 'i');
const SAVED_SLOT = new RegExp(`^(${UUID}):(winner|loser)$`, 'i');

export function bracketSlot(divisionId: string, semifinal: 1 | 2, outcome: BracketOutcome) {
  return `${divisionId}:semifinal-${semifinal}:${outcome}`;
}

export function parseBracketSlot(id: string) {
  const match = SLOT.exec(id);
  return match ? { divisionId: match[1], semifinal: Number(match[2]) as 1 | 2, outcome: match[3] as BracketOutcome } : null;
}

export function parseSavedSlot(id: string) {
  const match = SAVED_SLOT.exec(id);
  return match ? { gameId: match[1], outcome: match[2] as BracketOutcome } : null;
}

export function pendingLabel(outcome: string | null, home: string, away: string) {
  return `${home} / ${away} ${outcome === 'loser' ? 'loser' : 'winner'}`;
}

type PendingRow = { home_name: string | null; away_name: string | null; home_source_game_id: string | null; home_source_outcome: string | null; away_source_game_id: string | null; away_source_outcome: string | null };

// Names a playoff side that waits for a semifinal, such as "Lions / Rockets winner".
export async function labelPending<T extends PendingRow>(db: Kysely<DB> | Transaction<DB>, rows: T[]): Promise<(T & { home_name: string; away_name: string })[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.home_name === null ? row.home_source_game_id : null, row.away_name === null ? row.away_source_game_id : null]).filter((id): id is string => !!id))];
  const sources = ids.length ? await db.selectFrom('league.games as g')
    .innerJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').innerJoin('league.teams as ht', 'ht.id', 'h.team_id')
    .innerJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').innerJoin('league.teams as at', 'at.id', 'a.team_id')
    .select(['g.id', 'ht.name as home', 'at.name as away']).where('g.id', 'in', ids).execute() : [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const label = (id: string | null, outcome: string | null) => {
    const source = id ? byId.get(id) : undefined;
    return source ? pendingLabel(outcome, source.home, source.away) : 'To be decided';
  };
  return rows.map((row) => ({ ...row, home_name: row.home_name ?? label(row.home_source_game_id, row.home_source_outcome),
    away_name: row.away_name ?? label(row.away_source_game_id, row.away_source_outcome) }));
}
