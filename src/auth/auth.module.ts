import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthMailer } from './auth-mailer.service';
import { AuthService } from './auth.service';
import { AuthCleanup } from './auth-cleanup.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [DatabaseService, AuthService, AuthMailer, AuthRateLimitGuard, AuthCleanup],
  exports: [AuthService, DatabaseService],
})
export class AuthModule {}
