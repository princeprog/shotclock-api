import { Body, Controller, Delete, Get, Headers, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { ChangeEmailDto, ChangePasswordDto, EmailDto, LoginDto, LogoutDto, PasswordDto, RefreshDto, RegisterDto, ResetDto, TokenDto, UpdateProfileDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  register(@Body() body: RegisterDto) { return this.auth.register(body.email, body.password, body.name); }

  @Post('login') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  login(@Body() body: LoginDto) { return this.auth.login(body.email, body.password); }

  @Post('refresh') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  refresh(@Body() body: RefreshDto) { return this.auth.refresh(body.refreshToken); }

  @Post('logout') @HttpCode(204)
  logout(@Headers('authorization') authorization: string | undefined, @Body() body: LogoutDto) {
    return this.auth.logout(authorization, body?.refreshToken);
  }

  @Post('verify-email') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  verify(@Body() body: TokenDto) { return this.auth.consumeAction(body.token, 'verify'); }

  @Post('resend-verification') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  resend(@Body() body: EmailDto) { return this.auth.sendAction(body.email, 'verify'); }

  @Post('forgot-password') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  forgot(@Body() body: EmailDto) { return this.auth.sendAction(body.email, 'reset'); }

  @Post('reset-password') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  reset(@Body() body: ResetDto) { return this.auth.consumeAction(body.token, 'reset', body.password); }

  @Get('me')
  me(@Headers('authorization') authorization?: string) { return this.auth.me(authorization); }

  @Patch('me')
  updateProfile(@Headers('authorization') authorization: string | undefined, @Body() body: UpdateProfileDto) { return this.auth.updateProfile(authorization, body.name); }

  @Delete('me') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  deleteAccount(@Headers('authorization') authorization: string | undefined, @Body() body: PasswordDto) { return this.auth.deleteAccount(authorization, body.password); }

  @Post('change-password') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  changePassword(@Headers('authorization') authorization: string | undefined, @Body() body: ChangePasswordDto) { return this.auth.changePassword(authorization, body.currentPassword, body.newPassword); }

  @Post('sign-out-others') @HttpCode(200)
  signOutOthers(@Headers('authorization') authorization?: string) { return this.auth.signOutOthers(authorization); }

  @Post('change-email') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  changeEmail(@Headers('authorization') authorization: string | undefined, @Body() body: ChangeEmailDto) { return this.auth.changeEmail(authorization, body.newEmail, body.currentPassword); }

  @Post('confirm-email-change') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  confirmEmailChange(@Body() body: TokenDto) { return this.auth.confirmEmailChange(body.token); }
}
