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

  // Compare each team against all teams sharing its final overall win total.
  const headToHead = new Map(rows.map((row) => [row.id, { wins: 0, pointDifference: 0 }]));
  for (const game of games) {
    const home = byId.get(game.homeId);
    const away = byId.get(game.awayId);
    if (!home || !away || home.wins !== away.wins || game.homeScore === game.awayScore) continue;
    const homeRecord = headToHead.get(home.id)!;
    const awayRecord = headToHead.get(away.id)!;
    const difference = game.homeScore - game.awayScore;
    homeRecord.pointDifference += difference;
    awayRecord.pointDifference -= difference;
    if (difference > 0) homeRecord.wins++;
    else awayRecord.wins++;
  }

  return rows.sort((a, b) => {
    const aHeadToHead = headToHead.get(a.id)!;
    const bHeadToHead = headToHead.get(b.id)!;
    return b.wins - a.wins
      || bHeadToHead.wins - aHeadToHead.wins
      || bHeadToHead.pointDifference - aHeadToHead.pointDifference
      || b.pointDifference - a.pointDifference
      || a.name.localeCompare(b.name, 'en')
      || a.id.localeCompare(b.id)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
