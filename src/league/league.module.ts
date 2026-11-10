import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeagueController } from './league.controller';
import { LeagueService } from './league.service';
import { ScheduleService } from './schedule.service';

@Module({ imports: [AuthModule], controllers: [LeagueController], providers: [LeagueService, ScheduleService] })
export class LeagueModule {}
