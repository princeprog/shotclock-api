import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // A reviewed schedule can contain hundreds of games; keep the request bounded.
  app.useBodyParser('json', { limit: '256kb' });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) ||
      (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins, using HTTPS in production');
    }
  }
  app.enableCors({ origin: origins, credentials: false });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
