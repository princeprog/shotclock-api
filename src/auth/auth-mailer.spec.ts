import { ConfigService } from '@nestjs/config';
import { AuthMailer, authLink } from './auth-mailer.service';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

describe('authentication links', () => {
  it.each(['verify', 'reset'] as const)('keeps %s tokens in fragments', (purpose) => {
    const url = new URL(authLink(new URL('https://example.test'), purpose, 'token+/='));
    expect(url.pathname).toBe(purpose === 'verify' ? '/verify-email' : '/reset-password');
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe('token+/=');
  });
});

describe('SMTP delivery', () => {
  it('sends a verification link through a local SMTP server', async () => {
    let message = '';
    let received: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => { received = resolve; });
    const server: Server = createServer((socket) => {
      socket.write('220 localhost test SMTP\r\n');
      let buffer = '';
      let data = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (data) {
            if (line === '.') { data = false; socket.write('250 accepted\r\n'); received(); }
            else message += `${line}\n`;
          } else if (/^EHLO /i.test(line)) socket.write('250 localhost\r\n');
          else if (/^DATA$/i.test(line)) { data = true; socket.write('354 send message\r\n'); }
          else if (/^QUIT$/i.test(line)) socket.end('221 bye\r\n');
          else socket.write('250 accepted\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const mailer = new AuthMailer(new ConfigService({
        FRONTEND_URL: 'http://localhost:3000', SMTP_FROM: 'noreply@example.test', SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String((server.address() as AddressInfo).port), SMTP_REQUIRE_TLS: 'false',
      }));
      await mailer.send('person@example.test', 'verify', 'test-token');
      await delivery;
      expect(message).toContain('Subject: Verify your email');
      const decoded = message.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      expect(decoded).toContain('http://localhost:3000/verify-email#token=test-token');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('SMTP production configuration', () => {
  const base = { NODE_ENV: 'production', FRONTEND_URL: 'https://example.test',
    SMTP_FROM: 'test@example.test', SMTP_HOST: 'smtp.example.test' };
  it('rejects a non-TLS frontend or SMTP connection in production', () => {
    expect(() => new AuthMailer(new ConfigService({ ...base, FRONTEND_URL: 'http://example.test' }))).toThrow();
    expect(() => new AuthMailer(new ConfigService({ ...base, SMTP_REQUIRE_TLS: 'false' }))).toThrow();
  });
  it('accepts implicit TLS or required STARTTLS', () => {
    expect(() => new AuthMailer(new ConfigService({ ...base, SMTP_SECURE: 'true' }))).not.toThrow();
    expect(() => new AuthMailer(new ConfigService(base))).not.toThrow();
  });
});
