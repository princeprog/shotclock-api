import { calculateStandings, FinalGame, StandingTeam } from './standings';

describe('calculateStandings', () => {
  const teams: StandingTeam[] = [
    { id: 'a', name: 'Arrows' },
    { id: 'b', name: 'Bears' },
    { id: 'c', name: 'Cats' },
    { id: 'd', name: 'Dogs' },
  ];

  it('ranks overall wins first and preserves the standings totals', () => {
    const rows = calculateStandings(teams.slice(0, 3), [
      { homeId: 'a', awayId: 'b', homeScore: 10, awayScore: 0 },
      { homeId: 'b', awayId: 'c', homeScore: 100, awayScore: 1 },
      { homeId: 'a', awayId: 'c', homeScore: 1, awayScore: 0 },
    ]);

    expect(rows).toEqual([
      { id: 'a', name: 'Arrows', wins: 2, losses: 0, pointsFor: 11, pointsAgainst: 0, pointDifference: 11 },
      { id: 'b', name: 'Bears', wins: 1, losses: 1, pointsFor: 100, pointsAgainst: 11, pointDifference: 89 },
      { id: 'c', name: 'Cats', wins: 0, losses: 2, pointsFor: 1, pointsAgainst: 101, pointDifference: -100 },
    ]);
  });

  it('ranks a head-to-head winner above a team with a better overall point difference', () => {
    const rows = calculateStandings(teams.slice(0, 3), [
      { homeId: 'a', awayId: 'b', homeScore: 1, awayScore: 0 },
      { homeId: 'b', awayId: 'c', homeScore: 100, awayScore: 0 },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((row) => row.pointDifference)).toEqual([1, 99, -100]);
  });

  it('compares wins against the entire tied group before overall point difference', () => {
    const games: FinalGame[] = [
      { homeId: 'a', awayId: 'b', homeScore: 2, awayScore: 1 },
      { homeId: 'a', awayId: 'c', homeScore: 2, awayScore: 1 },
      { homeId: 'b', awayId: 'c', homeScore: 2, awayScore: 1 },
      { homeId: 'b', awayId: 'd', homeScore: 100, awayScore: 0 },
      { homeId: 'c', awayId: 'd', homeScore: 100, awayScore: 0 },
      { homeId: 'c', awayId: 'd', homeScore: 100, awayScore: 0 },
    ];

    const rows = calculateStandings(teams, games);
    expect(rows.map((row) => [row.id, row.wins, row.pointDifference])).toEqual([
      ['a', 2, 2], ['b', 2, 100], ['c', 2, 198], ['d', 0, -300],
    ]);
  });

  it('breaks a three-way cycle by head-to-head point difference', () => {
    const rows = calculateStandings(teams, [
      { homeId: 'a', awayId: 'b', homeScore: 10, awayScore: 0 },
      { homeId: 'b', awayId: 'c', homeScore: 5, awayScore: 0 },
      { homeId: 'c', awayId: 'a', homeScore: 2, awayScore: 0 },
      { homeId: 'b', awayId: 'd', homeScore: 100, awayScore: 0 },
      { homeId: 'c', awayId: 'd', homeScore: 10, awayScore: 0 },
      { homeId: 'a', awayId: 'd', homeScore: 1, awayScore: 0 },
    ]);

    expect(rows.map((row) => [row.id, row.wins, row.pointDifference])).toEqual([
      ['a', 2, 9], ['c', 2, 7], ['b', 2, 95], ['d', 0, -111],
    ]);
  });

  it('uses overall difference when tied teams have equal head-to-head records', () => {
    const rows = calculateStandings(teams, [
      { homeId: 'a', awayId: 'b', homeScore: 1, awayScore: 0 },
      { homeId: 'b', awayId: 'c', homeScore: 1, awayScore: 0 },
      { homeId: 'c', awayId: 'a', homeScore: 1, awayScore: 0 },
      { homeId: 'a', awayId: 'd', homeScore: 1, awayScore: 0 },
      { homeId: 'b', awayId: 'd', homeScore: 3, awayScore: 0 },
      { homeId: 'c', awayId: 'd', homeScore: 2, awayScore: 0 },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('ignores games with missing opponents or equal scores, while counting zero scores', () => {
    const rows = calculateStandings(teams.slice(0, 2), [
      { homeId: 'a', awayId: 'b', homeScore: 0, awayScore: 5 },
      { homeId: 'a', awayId: 'missing', homeScore: 100, awayScore: 0 },
      { homeId: 'missing', awayId: 'b', homeScore: 100, awayScore: 0 },
      { homeId: 'a', awayId: 'b', homeScore: 10, awayScore: 10 },
    ]);
    expect(rows).toEqual([
      { id: 'b', name: 'Bears', wins: 1, losses: 0, pointsFor: 5, pointsAgainst: 0, pointDifference: 5 },
      { id: 'a', name: 'Arrows', wins: 0, losses: 1, pointsFor: 0, pointsAgainst: 5, pointDifference: -5 },
    ]);
  });

  it('recalculates the head-to-head order after a score correction', () => {
    const games: FinalGame[] = [
      { homeId: 'a', awayId: 'b', homeScore: 2, awayScore: 1 },
      { homeId: 'b', awayId: 'c', homeScore: 10, awayScore: 0 },
    ];
    expect(calculateStandings(teams.slice(0, 3), games).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    games[0] = { ...games[0], homeScore: 0, awayScore: 1 };
    expect(calculateStandings(teams.slice(0, 3), games).map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('reorders a tied cycle when a corrected margin changes without changing the winner', () => {
    const games: FinalGame[] = [
      { homeId: 'a', awayId: 'b', homeScore: 10, awayScore: 0 },
      { homeId: 'b', awayId: 'c', homeScore: 5, awayScore: 0 },
      { homeId: 'c', awayId: 'a', homeScore: 4, awayScore: 0 },
    ];
    expect(calculateStandings(teams.slice(0, 3), games).map((row) => row.id)).toEqual(['a', 'c', 'b']);
    games[0] = { ...games[0], homeScore: 1 };
    expect(calculateStandings(teams.slice(0, 3), games).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(calculateStandings(teams.slice(0, 3).reverse(), [...games].reverse()).map((row) => row.id))
      .toEqual(['b', 'c', 'a']);
  });

  it('uses names and IDs deterministically for otherwise equal teams regardless of input order', () => {
    const tied = [
      { id: '2', name: 'Bears' },
      { id: '3', name: 'Arrows' },
      { id: '1', name: 'Bears' },
    ];
    expect(calculateStandings(tied, []).map((row) => row.id)).toEqual(['3', '1', '2']);
    expect(calculateStandings([...tied].reverse(), []).map((row) => row.id)).toEqual(['3', '1', '2']);
  });
});
