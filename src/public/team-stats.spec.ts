import { statLeaders, teamForm, teamStats, type ResultGame, type StatTeam } from './team-stats';

const team = (id: string, name: string): StatTeam => ({ id, teamId: `team-${id}`, name, abbreviation: null });
const game = (id: string, playedAt: number, homeId: string, awayId: string, homeScore: number, awayScore: number, forfeit = false): ResultGame => ({ id, playedAt, homeId, awayId, homeScore, awayScore, forfeit });

describe('team statistics', () => {
  const teams = [team('a', 'Arrows'), team('b', 'Bears'), team('c', 'Cats')];
  const games = [
    game('1', 1, 'a', 'b', 70, 60),
    game('2', 2, 'b', 'a', 80, 75),
    game('3', 3, 'a', 'c', 20, 0, true),
    game('4', 4, 'c', 'b', 50, 65),
  ];

  it('reads the streak and last five in date order regardless of input order', () => {
    expect(teamForm('a', [...games].reverse())).toEqual({ streak: 'W1', lastFive: ['W', 'L', 'W'] });
    expect(teamForm('b', games)).toEqual({ streak: 'W2', lastFive: ['W', 'W', 'L'] });
    expect(teamForm('x', games)).toEqual({ streak: null, lastFive: [] });
  });

  it('counts forfeits in the record but leaves them out of scoring averages', () => {
    const [arrows, , cats] = teamStats(teams, games);
    expect(arrows).toMatchObject({ gamesPlayed: 3, wins: 2, losses: 1, winPct: 0.667, scoredGames: 2, pointsFor: 145, pointsAgainst: 140, pointsPerGame: 72.5, allowedPerGame: 70, averageMargin: 2.5, forfeitWins: 1, home: { wins: 2, losses: 0 }, away: { wins: 0, losses: 1 } });
    expect(cats).toMatchObject({ gamesPlayed: 2, wins: 0, losses: 2, scoredGames: 1, pointsPerGame: 50, forfeitLosses: 1 });
  });

  it('leaves averages empty for a team without results', () => {
    expect(teamStats([team('z', 'Zebras')], games)[0]).toMatchObject({ gamesPlayed: 0, winPct: null, pointsPerGame: null, streak: null });
  });

  it('picks leaders and breaks ties by team name', () => {
    const leaders = statLeaders(teamStats(teams, games));
    expect(leaders.offense).toEqual({ team: teams[0], value: 72.5 });
    expect(leaders.defense).toEqual({ team: teams[1], value: 65 });
    expect(leaders.margin).toEqual({ team: teams[1], value: 3.3 });
    expect(leaders.winStreak).toEqual({ team: teams[1], value: 2 });
    const tied = statLeaders(teamStats([team('b', 'Bears'), team('a', 'Arrows')], [game('1', 1, 'a', 'b', 60, 50), game('2', 2, 'b', 'a', 60, 50)]));
    expect(tied.offense?.team.name).toBe('Arrows');
  });
});
