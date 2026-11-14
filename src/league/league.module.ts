import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeagueController } from './league.controller';
import { LeagueService } from './league.service';
import { ScheduleService } from './schedule.service';
import { LeagueRateLimitGuard } from './league-rate-limit.guard';

@Module({ imports: [AuthModule], controllers: [LeagueController], providers: [LeagueService, ScheduleService, LeagueRateLimitGuard] })
export class LeagueModule {}
