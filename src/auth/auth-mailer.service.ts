import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export function authLink(frontend: URL, purpose: 'verify' | 'reset', token: string): string {
  const url = new URL(purpose === 'verify' ? '/verify-email' : '/reset-password', frontend);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

@Injectable()
export class AuthMailer {
  private readonly logger = new Logger(AuthMailer.name);
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly frontend: URL;

  constructor(config: ConfigService) {
    this.frontend = new URL(config.getOrThrow<string>('FRONTEND_URL'));
    if (!['http:', 'https:'].includes(this.frontend.protocol) || this.frontend.username || this.frontend.password) {
      throw new Error('FRONTEND_URL must be an HTTP(S) URL without credentials');
    }
    if (config.get<string>('NODE_ENV') === 'production' && this.frontend.protocol !== 'https:') {
      throw new Error('FRONTEND_URL must use HTTPS in production');
    }
    this.from = config.getOrThrow<string>('SMTP_FROM').trim();
    const host = config.getOrThrow<string>('SMTP_HOST').trim();
    if (!this.from || !host) throw new Error('SMTP_FROM and SMTP_HOST must not be empty');
    const port = Number(config.get<string>('SMTP_PORT') ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT');
    for (const key of ['SMTP_SECURE', 'SMTP_REQUIRE_TLS']) {
      const value = config.get<string>(key);
      if (value !== undefined && value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
    }
    const secure = config.get<string>('SMTP_SECURE') === 'true';
    const requireTLS = !secure && config.get<string>('SMTP_REQUIRE_TLS') !== 'false';
    if (config.get<string>('NODE_ENV') === 'production' && !secure && !requireTLS) {
      throw new Error('SMTP must use TLS in production');
    }
    if (!!config.get<string>('SMTP_USER') !== !!config.get<string>('SMTP_PASSWORD')) {
      throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
    }
    this.transport = createTransport({
      host,
      port, secure, requireTLS,
      auth: config.get<string>('SMTP_USER') ? {
        user: config.getOrThrow<string>('SMTP_USER'),
        pass: config.getOrThrow<string>('SMTP_PASSWORD'),
      } : undefined,
    });
  }

  async send(email: string, purpose: 'verify' | 'reset', token: string): Promise<void> {
    const url = authLink(this.frontend, purpose, token);
    try {
      await this.transport.sendMail({
        from: this.from, to: email,
        subject: purpose === 'verify' ? 'Verify your email' : 'Reset your password',
        text: `Open this link to ${purpose === 'verify' ? 'verify your email' : 'reset your password'}: ${url}`,
      });
    } catch {
      // Do not leak the address, token, or SMTP credentials into logs or HTTP responses.
      this.logger.error('Failed to deliver an authentication email');
    }
  }
}
