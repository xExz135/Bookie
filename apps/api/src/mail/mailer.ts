import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only. */
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');
export const InjectMailer = () => Inject(MAILER);

/** Sends mail over SMTP: Mailpit locally (UI on :8025), real SMTP settings in production (D-001). */
@Injectable()
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private transport: Transporter | null = null;

  constructor(@InjectConfig() private readonly config: AppConfig) {}

  async send(message: MailMessage): Promise<void> {
    this.transport ??= createTransport({
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      secure: this.config.SMTP_PORT === 465,
      auth: this.config.SMTP_USER
        ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD ?? '' }
        : undefined,
    });
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...message });
  }

  onModuleDestroy(): void {
    this.transport?.close();
  }
}

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: SmtpMailer }],
  exports: [MAILER],
})
export class MailModule {}
