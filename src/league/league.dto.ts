import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsDateString, IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const positions = ['point_guard', 'shooting_guard', 'small_forward', 'power_forward', 'center'];

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
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsUUID('all', { each: true }) divisionIds?: string[];
}
export class DivisionDto extends NameDto {
  @IsOptional() @IsInt() @Min(1) @Max(150) minAge?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(150) maxAge?: number | null;
}
export class UpdateDivisionDto {
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(150) minAge?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(150) maxAge?: number | null;
}
export class DivisionFilterDto {
  @IsOptional() @IsUUID() divisionId?: string;
}
export class PlayerDto {
  @IsString() @MinLength(1) @MaxLength(80) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(80) lastName!: string;
  @IsDateString({ strict: true }) dateOfBirth!: string;
  @IsOptional() @IsIn(positions) position?: string | null;
}
export class UpdatePlayerDto {
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(80) firstName?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(80) lastName?: string;
  @ValidateIf((_, value) => value !== undefined) @IsDateString({ strict: true }) dateOfBirth?: string;
  @IsOptional() @IsIn(positions) position?: string | null;
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
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
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
  @IsOptional() @IsUUID() divisionId?: string;
}
export class MoveTeamRegistrationDto {
  @IsUUID() divisionId!: string;
}
export class RosterDto {
  @IsUUID() playerId!: string;
  @IsOptional() @IsInt() @Min(0) @Max(999) jerseyNumber?: number | null;
}
export class RosterFilterDto {
  @IsOptional() @IsString() @MaxLength(161) search?: string;
}
export class JerseyDto {
  @IsOptional() @IsUUID() seasonTeamId?: string;
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
  @ValidateIf((_object, value) => value !== undefined) @IsInt() @Min(1) @Max(1440) durationMinutes?: number;
}
export class GameFilterDto extends DivisionFilterDto {
  @IsOptional() @IsIn(['season']) scope?: 'season';
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

export class ScheduleWindowDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays!: number[];
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) startTime!: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) endTime!: string;
}
export class TeamUnavailabilityDto {
  @IsUUID() teamId!: string;
  @IsArray() @ArrayMaxSize(366) @ArrayUnique() @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true }) dates!: string[];
}
export class ScheduleAvailabilityDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ScheduleWindowDto) windows!: ScheduleWindowDto[];
  @IsString() @MinLength(1) @MaxLength(100) timeZone!: string;
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(100) @IsUUID('all', { each: true }) venueIds!: string[];
  @IsInt() @Min(1) @Max(1440) durationMinutes!: number;
  @IsInt() @Min(0) @Max(10080) restMinutes!: number;
  @IsOptional() @IsArray() @ArrayMaxSize(366) @ArrayUnique() @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true }) blackoutDates?: string[];
  @IsOptional() @IsIn(['weekly', 'spread', 'compact']) pace?: 'weekly' | 'spread' | 'compact';
  @IsOptional() @IsInt() @Min(1) @Max(10) maxGamesPerTeamPerDay?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) changeoverMinutes?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TeamUnavailabilityDto) teamUnavailability?: TeamUnavailabilityDto[];
}
export class ScheduleGameDto {
  @IsUUID() homeTeamId!: string;
  @IsUUID() awayTeamId!: string;
  @IsInt() @Min(1) @Max(500) round!: number;
  @IsIn(['preliminary', 'semifinal', 'final', 'third_place']) stage!: 'preliminary' | 'semifinal' | 'final' | 'third_place';
  @IsDateString({ strict: true }) @Matches(/(?:Z|[+-]\d\d:\d\d)$/) scheduledAt!: string;
  @IsUUID() venueId!: string;
  @IsInt() @Min(1) @Max(1440) durationMinutes!: number;
  @IsOptional() @IsString() @MaxLength(120) homeName?: string;
  @IsOptional() @IsString() @MaxLength(120) awayName?: string;
}
export class ScheduleAvailabilityRequestDto {
  @IsDefined() @ValidateNested() @Type(() => ScheduleAvailabilityDto) availability!: ScheduleAvailabilityDto;
}
export class SchedulePreviewDto extends ScheduleAvailabilityRequestDto {
  @IsIn(['single', 'double']) format!: 'single' | 'double';
  @IsBoolean() playoffs!: boolean;
  @IsBoolean() thirdPlace!: boolean;
}
export class ScheduleSaveDto extends SchedulePreviewDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => ScheduleGameDto) games!: ScheduleGameDto[];
}
export class PlayoffSaveDto extends ScheduleAvailabilityRequestDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => ScheduleGameDto) games!: ScheduleGameDto[];
}
export class SeasonScheduleGameDto extends ScheduleGameDto {
  @IsUUID() divisionId!: string;
  @IsOptional() @IsString() @MaxLength(120) divisionName?: string;
}
export class SeasonScheduleSaveDto extends SchedulePreviewDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) divisionIds!: string[];
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => SeasonScheduleGameDto) games!: SeasonScheduleGameDto[];
}
export class SeasonPlayoffSaveDto extends ScheduleAvailabilityRequestDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) divisionIds!: string[];
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => SeasonScheduleGameDto) games!: SeasonScheduleGameDto[];
}
export class ScheduleFixtureDto {
  @IsUUID() divisionId!: string;
  @IsUUID() homeTeamId!: string;
  @IsUUID() awayTeamId!: string;
  @IsInt() @Min(1) @Max(500) round!: number;
  @IsIn(['preliminary', 'semifinal', 'final', 'third_place']) stage!: 'preliminary' | 'semifinal' | 'final' | 'third_place';
}
export class ScheduleSuggestTargetDto {
  @IsOptional() @IsInt() @Min(0) @Max(4999) index?: number;
  @IsOptional() @ValidateNested() @Type(() => ScheduleFixtureDto) game?: ScheduleFixtureDto;
}
export class SeasonScheduleSuggestDto extends SchedulePreviewDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) divisionIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => SeasonScheduleGameDto) games!: SeasonScheduleGameDto[];
  @IsDefined() @ValidateNested() @Type(() => ScheduleSuggestTargetDto) target!: ScheduleSuggestTargetDto;
}
export class SeasonPlayoffSuggestDto extends ScheduleAvailabilityRequestDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) divisionIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => SeasonScheduleGameDto) games!: SeasonScheduleGameDto[];
  @IsDefined() @ValidateNested() @Type(() => ScheduleSuggestTargetDto) target!: ScheduleSuggestTargetDto;
}
