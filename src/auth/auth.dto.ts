import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class EmailDto {
  @IsEmail() @MaxLength(254) email: string;
}
export class RegisterDto extends EmailDto {
  @IsString() @MinLength(12) @MaxLength(128) password: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}
export class LoginDto extends EmailDto {
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}
export class TokenDto {
  @IsString() @MinLength(1) @MaxLength(512) token: string;
}
export class RefreshDto {
  @IsString() @MinLength(1) @MaxLength(512) refreshToken: string;
}
export class LogoutDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512) refreshToken?: string;
}
export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string | null;
}
export class PasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}
export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) currentPassword: string;
  @IsString() @MinLength(12) @MaxLength(128) newPassword: string;
}
export class ChangeEmailDto {
  @IsEmail() @MaxLength(254) newEmail: string;
  @IsString() @MinLength(1) @MaxLength(128) currentPassword: string;
}
export class ResetDto extends TokenDto {
  @IsString() @MinLength(12) @MaxLength(128) password: string;
}
