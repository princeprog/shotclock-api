import { bestPlayer } from './best-player';

const line = (rosterId: string, stats: Partial<{ points: number; rebounds: number; assists: number; steals: number; blocks: number; turnovers: number; fouls: number }>) =>
  ({ rosterId, points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, fouls: 0, ...stats });

describe('bestPlayer', () => {
  it('picks the highest efficiency, counting every stat and subtracting turnovers', () => {
    const scorer = line('a', { points: 20, turnovers: 8 });
    const allRound = line('b', { points: 10, rebounds: 6, assists: 5, steals: 1 });
    expect(bestPlayer([scorer, allRound])).toBe(allRound);
  });

  it('breaks ties by points, then fewer fouls, then roster id', () => {
    expect(bestPlayer([line('a', { points: 4, rebounds: 6 }), line('b', { points: 8, rebounds: 2 })])?.rosterId).toBe('b');
    expect(bestPlayer([line('a', { points: 8, fouls: 4 }), line('b', { points: 8, fouls: 1 })])?.rosterId).toBe('b');
    expect(bestPlayer([line('b', { points: 8 }), line('a', { points: 8 })])?.rosterId).toBe('a');
  });

  it('names no one when nobody on the winning team contributed', () => {
    expect(bestPlayer([])).toBeNull();
    expect(bestPlayer([line('a', { fouls: 3 }), line('b', { points: 1, turnovers: 1 })])).toBeNull();
  });
});
