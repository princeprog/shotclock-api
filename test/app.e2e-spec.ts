import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { AuthMailer } from '../src/auth/auth-mailer.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.AUTH_JWT_SECRET = 'a-test-secret-that-is-at-least-32-bytes';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(DatabaseService).useValue({})
      .overrideProvider(AuthMailer).useValue({ send: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Welcome to Shotclock API!');
  });

  afterEach(async () => {
    await app.close();
  });
});
