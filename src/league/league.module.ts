import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeagueController } from './league.controller';
import { LeagueService } from './league.service';
import { ScorekeepersController } from './scorekeepers.controller';
import { ScorekeepersService } from './scorekeepers.service';
import { InvitationsController } from './invitations.controller';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';
import { ScheduleService } from './schedule.service';
import { LeagueRateLimitGuard } from './league-rate-limit.guard';
import { PublicModule } from '../public/public.module';

@Module({ imports: [AuthModule, PublicModule], controllers: [LeagueController, ScorekeepersController, InvitationsController, LiveController], providers: [LeagueService, ScheduleService, ScorekeepersService, LiveService, LeagueRateLimitGuard], exports: [LiveService] })
export class LeagueModule {}
