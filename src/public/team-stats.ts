// Team statistics derived from final scores. Scores are never tied, so every final game has a winner.
export type ResultGame = { id: string; homeId: string; awayId: string; homeScore: number; awayScore: number; forfeit: boolean; playedAt: number };
export type StatTeam = { id: string; teamId: string; name: string; abbreviation: string | null };
export type Outcome = 'W' | 'L';
export type Form = { streak: string | null; lastFive: Outcome[] };
export type Record = { wins: number; losses: number };
export type TeamStats = {
  team: StatTeam; gamesPlayed: number; wins: number; losses: number; winPct: number | null;
  scoredGames: number; pointsFor: number; pointsAgainst: number;
  pointsPerGame: number | null; allowedPerGame: number | null; averageMargin: number | null;
  home: Record; away: Record; forfeitWins: number; forfeitLosses: number;
} & Form;
export type Leader = { team: StatTeam; value: number } | null;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const chronological = (games: ResultGame[]) => [...games].sort((a, b) => a.playedAt - b.playedAt || a.id.localeCompare(b.id));
const involves = (teamId: string, game: ResultGame) => game.homeId === teamId || game.awayId === teamId;
const won = (teamId: string, game: ResultGame) => (game.homeId === teamId) === (game.homeScore > game.awayScore);

export function winPct(wins: number, losses: number) {
  return wins + losses ? round(wins / (wins + losses), 3) : null;
}

// The current streak ("W3") and the last five outcomes, most recent first.
export function teamForm(teamId: string, games: ResultGame[]): Form {
  const outcomes: Outcome[] = chronological(games).filter((game) => involves(teamId, game)).map((game) => (won(teamId, game) ? 'W' : 'L'));
  const last = outcomes.at(-1);
  if (!last) return { streak: null, lastFive: [] };
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === last; i--) count++;
  return { streak: `${last}${count}`, lastFive: outcomes.slice(-5).reverse() };
}

// Forfeits count as wins and losses but are left out of scoring, because the 20–0 score was not played.
export function teamStats(teams: StatTeam[], games: ResultGame[]): TeamStats[] {
  return teams.map((team) => {
    const row: TeamStats = { team, gamesPlayed: 0, wins: 0, losses: 0, winPct: null, scoredGames: 0, pointsFor: 0, pointsAgainst: 0, pointsPerGame: null, allowedPerGame: null, averageMargin: null, home: { wins: 0, losses: 0 }, away: { wins: 0, losses: 0 }, forfeitWins: 0, forfeitLosses: 0, ...teamForm(team.id, games) };
    for (const game of games) {
      if (!involves(team.id, game)) continue;
      const home = game.homeId === team.id;
      const win = won(team.id, game);
      const venue = home ? row.home : row.away;
      row.gamesPlayed++;
      if (win) { row.wins++; venue.wins++; } else { row.losses++; venue.losses++; }
      if (game.forfeit) { if (win) row.forfeitWins++; else row.forfeitLosses++; continue; }
      row.scoredGames++;
      row.pointsFor += home ? game.homeScore : game.awayScore;
      row.pointsAgainst += home ? game.awayScore : game.homeScore;
    }
    row.winPct = winPct(row.wins, row.losses);
    if (row.scoredGames) {
      row.pointsPerGame = round(row.pointsFor / row.scoredGames, 1);
      row.allowedPerGame = round(row.pointsAgainst / row.scoredGames, 1);
      row.averageMargin = round((row.pointsFor - row.pointsAgainst) / row.scoredGames, 1);
    }
    return row;
  });
}

function best(rows: TeamStats[], value: (row: TeamStats) => number | null, direction: 1 | -1): Leader {
  let leader: { team: StatTeam; value: number } | null = null;
  for (const row of rows) {
    const current = value(row);
    if (current === null) continue;
    if (!leader || (current - leader.value) * direction > 0 || (current === leader.value && row.team.name.localeCompare(leader.team.name, 'en') < 0)) leader = { team: row.team, value: current };
  }
  return leader;
}

export function statLeaders(rows: TeamStats[]) {
  return {
    offense: best(rows, (row) => row.pointsPerGame, 1),
    defense: best(rows, (row) => row.allowedPerGame, -1),
    margin: best(rows, (row) => row.averageMargin, 1),
    winStreak: best(rows, (row) => (row.streak?.startsWith('W') ? Number(row.streak.slice(1)) : null), 1),
  };
}
