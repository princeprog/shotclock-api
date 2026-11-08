import { calculateStandings } from './standings';

describe('standings', () => {
  it('counts completed results and orders by wins, point difference, then team name', () => {
    const teams = [{ id: 'a', name: 'Arrows' }, { id: 'b', name: 'Bears' }, { id: 'c', name: 'Cats' }];
    const rows = calculateStandings(teams, [
      { homeId: 'b', awayId: 'a', homeScore: 80, awayScore: 70 },
      { homeId: 'c', awayId: 'b', homeScore: 75, awayScore: 70 },
    ]);
    expect(rows.map((row) => [row.name, row.wins, row.losses, row.pointDifference])).toEqual([
      ['Bears', 1, 1, 5], ['Cats', 1, 0, 5], ['Arrows', 0, 1, -10],
    ]);
    const corrected = calculateStandings(teams, [{ homeId: 'b', awayId: 'a', homeScore: 60, awayScore: 70 }]);
    expect(corrected[0].name).toBe('Arrows');
  });
});
