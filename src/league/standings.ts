export type StandingTeam = { id: string; name: string };
export type FinalGame = { homeId: string; awayId: string; homeScore: number; awayScore: number };

export function calculateStandings(teams: StandingTeam[], games: FinalGame[]) {
  const rows = teams.map((team) => ({ ...team, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, pointDifference: 0 }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const game of games) {
    const home = byId.get(game.homeId);
    const away = byId.get(game.awayId);
    if (!home || !away || game.homeScore === game.awayScore) continue;
    home.pointsFor += game.homeScore;
    home.pointsAgainst += game.awayScore;
    away.pointsFor += game.awayScore;
    away.pointsAgainst += game.homeScore;
    if (game.homeScore > game.awayScore) { home.wins++; away.losses++; }
    else { away.wins++; home.losses++; }
  }
  for (const row of rows) row.pointDifference = row.pointsFor - row.pointsAgainst;
  return rows.sort((a, b) => b.wins - a.wins || b.pointDifference - a.pointDifference || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
}
