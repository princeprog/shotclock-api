import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE SCHEMA auth`.execute(db);
  await sql`CREATE SCHEMA league`.execute(db);

  await sql`ALTER TABLE public.auth_users SET SCHEMA auth`.execute(db);
  await sql`ALTER TABLE auth.auth_users RENAME TO users`.execute(db);
  await sql`ALTER TABLE public.auth_sessions SET SCHEMA auth`.execute(db);
  await sql`ALTER TABLE auth.auth_sessions RENAME TO sessions`.execute(db);
  await sql`ALTER TABLE public.auth_refresh_tokens SET SCHEMA auth`.execute(db);
  await sql`ALTER TABLE auth.auth_refresh_tokens RENAME TO refresh_tokens`.execute(db);
  await sql`ALTER TABLE public.auth_action_tokens SET SCHEMA auth`.execute(db);
  await sql`ALTER TABLE auth.auth_action_tokens RENAME TO action_tokens`.execute(db);
  await sql`ALTER TABLE public.auth_rate_limits SET SCHEMA auth`.execute(db);
  await sql`ALTER TABLE auth.auth_rate_limits RENAME TO rate_limits`.execute(db);

  await sql`CREATE TABLE league.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL REFERENCES auth.users(id),
    name text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.leagues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES league.organizations(id),
    name text NOT NULL, location text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.league_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), league_id uuid NOT NULL REFERENCES league.leagues(id),
    user_id uuid NOT NULL REFERENCES auth.users(id), role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.seasons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), league_id uuid NOT NULL REFERENCES league.leagues(id),
    name text NOT NULL, start_date date, end_date date, status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, league_id)
  )`.execute(db);
  await sql`CREATE TABLE league.teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), league_id uuid NOT NULL REFERENCES league.leagues(id),
    name text NOT NULL, abbreviation text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id, league_id)
  )`.execute(db);
  await sql`CREATE TABLE league.season_teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), season_id uuid NOT NULL, team_id uuid NOT NULL, league_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id, season_id),
    FOREIGN KEY (season_id, league_id) REFERENCES league.seasons(id, league_id),
    FOREIGN KEY (team_id, league_id) REFERENCES league.teams(id, league_id)
  )`.execute(db);
  await sql`CREATE TABLE league.players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES auth.users(id),
    first_name text NOT NULL, last_name text NOT NULL, date_of_birth date,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.rosters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), season_team_id uuid NOT NULL REFERENCES league.season_teams(id),
    player_id uuid NOT NULL REFERENCES league.players(id), jersey_number integer CHECK (jersey_number >= 0),
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.venues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), league_id uuid NOT NULL REFERENCES league.leagues(id), name text NOT NULL,
    address text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await sql`CREATE TABLE league.games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), season_id uuid NOT NULL REFERENCES league.seasons(id), venue_id uuid REFERENCES league.venues(id),
    home_season_team_id uuid NOT NULL, away_season_team_id uuid NOT NULL, scheduled_at timestamptz,
    status text NOT NULL DEFAULT 'scheduled', home_score integer CHECK (home_score >= 0), away_score integer CHECK (away_score >= 0),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (home_season_team_id, season_id) REFERENCES league.season_teams(id, season_id),
    FOREIGN KEY (away_season_team_id, season_id) REFERENCES league.season_teams(id, season_id)
  )`.execute(db);
  await sql`CREATE TABLE league.player_game_stats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES league.games(id), roster_id uuid NOT NULL REFERENCES league.rosters(id),
    points integer NOT NULL DEFAULT 0 CHECK (points >= 0), rebounds integer NOT NULL DEFAULT 0 CHECK (rebounds >= 0),
    assists integer NOT NULL DEFAULT 0 CHECK (assists >= 0), steals integer NOT NULL DEFAULT 0 CHECK (steals >= 0),
    blocks integer NOT NULL DEFAULT 0 CHECK (blocks >= 0), turnovers integer NOT NULL DEFAULT 0 CHECK (turnovers >= 0),
    fouls integer NOT NULL DEFAULT 0 CHECK (fouls >= 0), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);

  await sql`CREATE INDEX organizations_owner_user_id_idx ON league.organizations(owner_user_id)`.execute(db);
  await sql`CREATE INDEX leagues_organization_id_idx ON league.leagues(organization_id)`.execute(db);
  await sql`CREATE INDEX league_members_league_id_idx ON league.league_members(league_id)`.execute(db);
  await sql`CREATE INDEX league_members_user_id_idx ON league.league_members(user_id)`.execute(db);
  await sql`CREATE INDEX seasons_league_id_idx ON league.seasons(league_id)`.execute(db);
  await sql`CREATE INDEX teams_league_id_idx ON league.teams(league_id)`.execute(db);
  await sql`CREATE INDEX season_teams_season_league_idx ON league.season_teams(season_id, league_id)`.execute(db);
  await sql`CREATE INDEX season_teams_team_league_idx ON league.season_teams(team_id, league_id)`.execute(db);
  await sql`CREATE INDEX rosters_season_team_id_idx ON league.rosters(season_team_id)`.execute(db);
  await sql`CREATE INDEX rosters_player_id_idx ON league.rosters(player_id)`.execute(db);
  await sql`CREATE INDEX venues_league_id_idx ON league.venues(league_id)`.execute(db);
  await sql`CREATE INDEX games_season_id_idx ON league.games(season_id)`.execute(db);
  await sql`CREATE INDEX games_venue_id_idx ON league.games(venue_id)`.execute(db);
  await sql`CREATE INDEX games_home_season_team_idx ON league.games(home_season_team_id, season_id)`.execute(db);
  await sql`CREATE INDEX games_away_season_team_idx ON league.games(away_season_team_id, season_id)`.execute(db);
  await sql`CREATE INDEX player_game_stats_game_id_idx ON league.player_game_stats(game_id)`.execute(db);
  await sql`CREATE INDEX player_game_stats_roster_id_idx ON league.player_game_stats(roster_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE league.player_game_stats`.execute(db);
  await sql`DROP TABLE league.games`.execute(db);
  await sql`DROP TABLE league.venues`.execute(db);
  await sql`DROP TABLE league.rosters`.execute(db);
  await sql`DROP TABLE league.players`.execute(db);
  await sql`DROP TABLE league.season_teams`.execute(db);
  await sql`DROP TABLE league.teams`.execute(db);
  await sql`DROP TABLE league.seasons`.execute(db);
  await sql`DROP TABLE league.league_members`.execute(db);
  await sql`DROP TABLE league.leagues`.execute(db);
  await sql`DROP TABLE league.organizations`.execute(db);
  await sql`ALTER TABLE auth.rate_limits RENAME TO auth_rate_limits`.execute(db);
  await sql`ALTER TABLE auth.auth_rate_limits SET SCHEMA public`.execute(db);
  await sql`ALTER TABLE auth.action_tokens RENAME TO auth_action_tokens`.execute(db);
  await sql`ALTER TABLE auth.auth_action_tokens SET SCHEMA public`.execute(db);
  await sql`ALTER TABLE auth.refresh_tokens RENAME TO auth_refresh_tokens`.execute(db);
  await sql`ALTER TABLE auth.auth_refresh_tokens SET SCHEMA public`.execute(db);
  await sql`ALTER TABLE auth.sessions RENAME TO auth_sessions`.execute(db);
  await sql`ALTER TABLE auth.auth_sessions SET SCHEMA public`.execute(db);
  await sql`ALTER TABLE auth.users RENAME TO auth_users`.execute(db);
  await sql`ALTER TABLE auth.auth_users SET SCHEMA public`.execute(db);
  await sql`DROP SCHEMA league`.execute(db);
  await sql`DROP SCHEMA auth`.execute(db);
}
