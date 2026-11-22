import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PublicController } from './public.controller';
import { PublicRateLimitGuard } from './public-rate-limit.guard';
import { PublicRevalidationInterceptor } from './public-revalidation.interceptor';
import { PublicService } from './public.service';
import { WebsiteRevalidationService } from './website-revalidation.service';
import { LiveStreamService } from './live-stream.service';

@Module({
  imports: [AuthModule],
  controllers: [PublicController],
  providers: [PublicService, PublicRateLimitGuard, WebsiteRevalidationService, PublicRevalidationInterceptor, LiveStreamService],
  exports: [WebsiteRevalidationService, PublicRevalidationInterceptor],
})
export class PublicModule {}
