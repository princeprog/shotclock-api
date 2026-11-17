import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class DirectoryQueryDto {
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
}
export class UpcomingQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}
export class DivisionQueryDto {
  @IsOptional() @IsUUID() division?: string;
}
export class GamesQueryDto extends DivisionQueryDto {
  @IsOptional() @IsUUID() team?: string;
  @IsOptional() @IsIn(['upcoming', 'results', 'all']) view?: 'upcoming' | 'results' | 'all';
}
