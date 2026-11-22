import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthMailer } from './auth-mailer.service';
import { AuthService } from './auth.service';
import { AuthCleanup } from './auth-cleanup.service';
import { RateLimitService } from '../common/rate-limit.service';
import { SecurityEventsService } from '../common/security-events.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [DatabaseService, AuthService, AuthMailer, AuthRateLimitGuard, AuthCleanup, RateLimitService, SecurityEventsService],
  exports: [AuthService, AuthMailer, DatabaseService, RateLimitService, SecurityEventsService],
})
export class AuthModule {}
