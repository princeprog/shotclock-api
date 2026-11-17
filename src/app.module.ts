import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { LeagueModule } from './league/league.module';
import { AuthController } from './auth/auth.controller';
import { LeagueController } from './league/league.controller';
import { PublicModule } from './public/public.module';
import { PublicController } from './public/public.controller';
import { RequestScopeMiddleware } from './common/request-scope';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    AuthModule,
    LeagueModule,
    PublicModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(RequestScopeMiddleware).forRoutes(AppController, AuthController, LeagueController, PublicController); }
}
