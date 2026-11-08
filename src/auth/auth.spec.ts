import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { DatabaseService } from '../database/database.service';
import { AuthMailer } from './auth-mailer.service';

describe('authentication HTTP contract', () => {
  it('rejects unauthenticated requests to /auth/me', async () => {
    process.env.AUTH_JWT_SECRET = 'a-test-secret-that-is-at-least-32-bytes';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({})
      .overrideProvider(AuthMailer)
      .useValue({ send: async () => undefined })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    } finally {
      await app.close();
    }
  });
});
