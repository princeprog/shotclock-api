import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeagueController } from './league.controller';
import { LeagueService } from './league.service';
import { ScorekeepersController } from './scorekeepers.controller';
import { ScorekeepersService } from './scorekeepers.service';
import { InvitationsController } from './invitations.controller';
import { ScheduleService } from './schedule.service';
import { LeagueRateLimitGuard } from './league-rate-limit.guard';
import { PublicModule } from '../public/public.module';

@Module({ imports: [AuthModule, PublicModule], controllers: [LeagueController, ScorekeepersController, InvitationsController], providers: [LeagueService, ScheduleService, ScorekeepersService, LeagueRateLimitGuard] })
export class LeagueModule {}
