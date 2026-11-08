import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class NameDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}
export class LeagueDto extends NameDto {
  @IsOptional() @IsString() @MaxLength(160) location?: string | null;
}
export class TeamDto extends NameDto {
  @IsOptional() @IsString() @MaxLength(12) abbreviation?: string | null;
}
export class CreateTeamDto extends TeamDto {
  @IsUUID() seasonId!: string;
}
export class SeasonDto extends NameDto {
  @IsOptional() @IsDateString({ strict: true }) startDate?: string | null;
  @IsOptional() @IsDateString({ strict: true }) endDate?: string | null;
}
export class SeasonFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(['draft', 'active', 'completed']) status?: 'draft' | 'active' | 'completed';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
export class OrganizationSeasonFilterDto extends SeasonFilterDto {
  @IsOptional() @IsUUID() leagueId?: string;
}
export class OrganizationTeamFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsUUID() leagueId?: string;
  @IsOptional() @IsUUID() seasonId?: string;
}
export class OrganizationVenueFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsUUID() leagueId?: string;
}
export class StatusDto {
  @IsIn(['active', 'completed']) status!: 'active' | 'completed';
}
export class TeamRegistrationDto {
  @IsUUID() teamId!: string;
}
export class RosterDto {
  @IsString() @MinLength(1) @MaxLength(80) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(80) lastName!: string;
  @IsOptional() @IsInt() @Min(0) @Max(999) jerseyNumber?: number | null;
}
export class RosterFilterDto {
  @IsOptional() @IsString() @MaxLength(161) search?: string;
}
export class JerseyDto {
  @IsOptional() @IsInt() @Min(0) @Max(999) jerseyNumber?: number | null;
}
export class VenueDto extends NameDto {
  @IsOptional() @IsString() @MaxLength(250) address?: string | null;
}
export class GameDto {
  @IsUUID() homeTeamId!: string;
  @IsUUID() awayTeamId!: string;
  @IsDateString({ strict: true }) scheduledAt!: string;
  @IsOptional() @IsUUID() venueId?: string | null;
}
export class GameFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(['scheduled', 'completed']) status?: 'scheduled' | 'completed';
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() venueId?: string;
  @IsOptional() @IsDateString({ strict: true }) from?: string;
  @IsOptional() @IsDateString({ strict: true }) to?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sort?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
export class ScoreDto {
  @IsInt() @Min(0) @Max(9999) homeScore!: number;
  @IsInt() @Min(0) @Max(9999) awayScore!: number;
}
