export type StatLine = { rosterId: string; points: number; rebounds: number; assists: number; steals: number; blocks: number; turnovers: number; fouls: number };

// Box-score efficiency without shooting attempts, which live scoring does not record.
export function efficiency(line: StatLine) {
  return line.points + line.rebounds + line.assists + line.steals + line.blocks - line.turnovers;
}

// Orders lines best first: higher efficiency, then more points, then fewer fouls, then roster id so the pick never varies.
function compare(a: StatLine, b: StatLine) {
  return efficiency(b) - efficiency(a) || b.points - a.points || a.fouls - b.fouls || (a.rosterId < b.rosterId ? -1 : a.rosterId > b.rosterId ? 1 : 0);
}

// The best player comes from the winning team and must have contributed something; otherwise there is none.
// The migration that added best players backfills older games with the same rule in SQL.
export function bestPlayer<T extends StatLine>(winningLines: T[]): T | null {
  let best: T | null = null;
  for (const line of winningLines) {
    if (efficiency(line) > 0 && (!best || compare(line, best) < 0)) best = line;
  }
  return best;
}
