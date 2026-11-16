import { revalidationTags, routeResource } from './website-revalidation.service';

describe('website revalidation routing', () => {
  const id = '0b6f3f2e-4a3b-4c55-9e1f-2f6c1c7d9a10';
  it('maps league writes to the record that identifies the league', () => {
    expect(routeResource('POST', `/league/games/${id}/score`)).toEqual({ resource: 'games', id });
    expect(routeResource('PATCH', `/league/leagues/${id}/publication`)).toEqual({ resource: 'leagues', id });
    expect(routeResource('DELETE', `/league/season-teams/${id}`)).toEqual({ resource: 'season-teams', id });
    expect(routeResource('POST', `/league/seasons/${id}/schedule`)).toEqual({ resource: 'seasons', id });
  });
  it('ignores reads, schedule previews and data the website never shows', () => {
    expect(routeResource('GET', `/league/games/${id}`)).toBeNull();
    expect(routeResource('POST', `/league/seasons/${id}/schedule/preview`)).toBeNull();
    expect(routeResource('PATCH', `/league/rosters/${id}`)).toBeNull();
    expect(routeResource('PATCH', `/league/players/${id}`)).toBeNull();
    expect(routeResource('POST', '/league/organizations')).toBeNull();
  });
  it('builds unique tags and skips the directory when no league is published', () => {
    expect(revalidationTags(['metro', 'metro', 'bay'])).toEqual(['directory', 'league:metro', 'league:bay']);
    expect(revalidationTags([])).toEqual([]);
  });
});
