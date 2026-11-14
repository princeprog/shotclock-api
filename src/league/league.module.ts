import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RequestScopeMiddleware } from '../common/request-scope';
import { LeagueController } from './league.controller';
import { LeagueService } from './league.service';
import { ScheduleService } from './schedule.service';

@Module({ imports: [AuthModule], controllers: [LeagueController], providers: [LeagueService, ScheduleService] })
export class LeagueModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(RequestScopeMiddleware).forRoutes(LeagueController); }
}
