import { sql, type Kysely } from 'kysely'

// A live-scored game names one best player when it finishes. The flag lives on that player's stat line,
// so it goes away whenever the game's stats are replaced or removed.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE league.player_game_stats ADD COLUMN best_player boolean NOT NULL DEFAULT false`.execute(db)
  await sql`CREATE UNIQUE INDEX player_game_stats_best_player_key ON league.player_game_stats(game_id) WHERE best_player`.execute(db)
  // Games finished before this change get their best player with the same rule as src/league/best-player.ts.
  await sql`UPDATE league.player_game_stats pgs SET best_player = true FROM (
    SELECT DISTINCT ON (s.game_id) s.id FROM league.player_game_stats s
    JOIN league.games g ON g.id = s.game_id
    JOIN league.rosters r ON r.id = s.roster_id
    WHERE g.status = 'completed'
      AND r.season_team_id = CASE WHEN g.home_score > g.away_score THEN g.home_season_team_id ELSE g.away_season_team_id END
      AND s.points + s.rebounds + s.assists + s.steals + s.blocks - s.turnovers > 0
    ORDER BY s.game_id, s.points + s.rebounds + s.assists + s.steals + s.blocks - s.turnovers DESC, s.points DESC, s.fouls ASC, s.roster_id ASC
  ) best WHERE pgs.id = best.id`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX league.player_game_stats_best_player_key`.execute(db)
  await sql`ALTER TABLE league.player_game_stats DROP COLUMN best_player`.execute(db)
}
