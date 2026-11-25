import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/db';

export type BracketOutcome = 'winner' | 'loser';
export type BracketStage = 'quarterfinal' | 'semifinal';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A schedule side is a season team, or in a playoff draft a seed that the final standings decide ("<division>:seed-1"),
// or the winner or loser of a quarterfinal or semifinal that is not played yet.
// A slot names a game in the same draft ("<division>:quarterfinal-1:winner") or one already saved ("<game>:winner").
export const TEAM_OR_SLOT = new RegExp(`^${UUID}(?::(?:quarterfinal-[1-4]|semifinal-[12]):(?:winner|loser)|:(?:winner|loser)|:seed-[1-8])?$`, 'i');
const SLOT = new RegExp(`^(${UUID}):(quarterfinal|semifinal)-([1-4]):(winner|loser)$`, 'i');
const SAVED_SLOT = new RegExp(`^(${UUID}):(winner|loser)$`, 'i');
const SEED = new RegExp(`^(${UUID}):seed-([1-8])$`, 'i');

// Seeds in bracket order, two per game: 1 vs 4 and 2 vs 3 for four teams; 1 vs 8, 4 vs 5, 2 vs 7 and 3 vs 6 for eight.
// Neighbouring games feed the same next-round game, so the top two seeds can only meet in the championship.
export function bracketOrder(size: number) {
  let order = [1];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, total - seed]);
  }
  return order;
}

export function seedSlot(divisionId: string, seed: number) {
  return `${divisionId}:seed-${seed}`;
}

export function parseSeedSlot(id: string) {
  const match = SEED.exec(id);
  return match ? { divisionId: match[1], seed: Number(match[2]) } : null;
}

export function seedLabel(seed: number) {
  return `${seed}${['st', 'nd', 'rd', 'th'][Math.min(seed, 4) - 1]} seed`;
}

export function bracketSlot(divisionId: string, stage: BracketStage, number: number, outcome: BracketOutcome) {
  return `${divisionId}:${stage}-${number}:${outcome}`;
}

export function parseBracketSlot(id: string) {
  const match = SLOT.exec(id);
  return match ? { divisionId: match[1], stage: match[2].toLowerCase() as BracketStage, number: Number(match[3]), outcome: match[4] as BracketOutcome } : null;
}

export function parseSavedSlot(id: string) {
  const match = SAVED_SLOT.exec(id);
  return match ? { gameId: match[1], outcome: match[2] as BracketOutcome } : null;
}

export function pendingLabel(outcome: string | null, home: string, away: string) {
  return `${home} / ${away} ${outcome === 'loser' ? 'loser' : 'winner'}`;
}

const stageNames: Record<string, string> = { quarterfinal: 'Quarterfinal', semifinal: 'Semifinal' };

// Names the winner or loser of a playoff game: "Lions / Rockets winner" while both of its sides are teams or seeds,
// otherwise its place in the bracket, such as "Semifinal 1 winner" for a semifinal still waiting for quarterfinals.
export function resultLabel(outcome: string | null, stage: string, number: number | null, home: string | null, away: string | null) {
  if (home !== null && away !== null) return pendingLabel(outcome, home, away);
  return `${stageNames[stage] ?? 'Playoff'}${number ? ' ' + number : ''} ${outcome === 'loser' ? 'loser' : 'winner'}`;
}

type PendingRow = { home_name: string | null; away_name: string | null; home_seed: number | null; away_seed: number | null;
  home_source_game_id: string | null; home_source_outcome: string | null; away_source_game_id: string | null; away_source_outcome: string | null };
type Source = PendingRow & { id: string; stage: string };

// Names a playoff side that waits for the standings ("1st seed") or for an earlier playoff game ("Lions / Rockets winner").
// Sources are loaded level by level, because a championship can wait for semifinals that wait for quarterfinals.
export async function labelPending<T extends PendingRow>(db: Kysely<DB> | Transaction<DB>, rows: T[]): Promise<(T & { home_name: string; away_name: string })[]> {
  const sources = new Map<string, Source>();
  let ids = [...new Set(rows.flatMap((row) => [row.home_name === null ? row.home_source_game_id : null, row.away_name === null ? row.away_source_game_id : null]).filter((id): id is string => !!id))];
  while (ids.length) {
    const found = await db.selectFrom('league.games as g')
      .leftJoin('league.season_teams as h', 'h.id', 'g.home_season_team_id').leftJoin('league.teams as ht', 'ht.id', 'h.team_id')
      .leftJoin('league.season_teams as a', 'a.id', 'g.away_season_team_id').leftJoin('league.teams as at', 'at.id', 'a.team_id')
      .select(['g.id', 'g.stage', 'ht.name as home_name', 'at.name as away_name', 'g.home_seed', 'g.away_seed',
        'g.home_source_game_id', 'g.home_source_outcome', 'g.away_source_game_id', 'g.away_source_outcome']).where('g.id', 'in', ids).execute();
    for (const source of found) sources.set(source.id, source);
    ids = [...new Set(found.flatMap((source) => [source.home_source_game_id, source.away_source_game_id]).filter((id): id is string => !!id && !sources.has(id)))];
  }
  // A semifinal's number is its best seed: the one holding seed 1 is semifinal 1.
  const lowestSeed = (game: Source): number | null => {
    const seeds = [game.home_seed, game.away_seed, ...[game.home_source_game_id, game.away_source_game_id].map((id) => {
      const source = id ? sources.get(id) : undefined;
      return source ? lowestSeed(source) : null;
    })].filter((seed): seed is number => seed !== null);
    return seeds.length ? Math.min(...seeds) : null;
  };
  const known = (name: string | null, seed: number | null) => name ?? (seed ? seedLabel(seed) : null);
  const label = (name: string | null, seed: number | null, id: string | null, outcome: string | null): string => {
    const named = known(name, seed);
    if (named !== null) return named;
    const source = id ? sources.get(id) : undefined;
    if (!source) return 'To be decided';
    return resultLabel(outcome, source.stage, source.stage === 'semifinal' ? lowestSeed(source) : null, known(source.home_name, source.home_seed), known(source.away_name, source.away_seed));
  };
  return rows.map((row) => ({ ...row, home_name: label(row.home_name, row.home_seed, row.home_source_game_id, row.home_source_outcome),
    away_name: label(row.away_name, row.away_seed, row.away_source_game_id, row.away_source_outcome) }));
}
