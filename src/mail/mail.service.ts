import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';

export type MailSendResult = { sent: true } | { sent: false; error: string };

function resolveTemplatesDir(): string {
  const candidates = [
    join(__dirname, 'templates'),
    join(process.cwd(), 'dist', 'src', 'mail', 'templates'),
    join(process.cwd(), 'dist', 'mail', 'templates'),
    join(process.cwd(), 'src', 'mail', 'templates'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(`Mail templates not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

/**
 * Minimal Handlebars {{var}} replace (no partials) — enough for our email templates.
 * Avoids adding a handlebars dependency just for Brevo HTTPS path.
 */
function renderTemplate(source: string, context: Record<string, unknown>): string {
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly appName: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  /** When set, send via Brevo HTTPS API (works on Railway Hobby). Else SMTP (local / Railway Pro). */
  private readonly brevoApiKey: string | null;
  private readonly templatesDir: string;

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    this.appName = this.configService.getOrThrow<string>('MAIL_FROM_NAME').trim();
    this.fromEmail = this.configService.getOrThrow<string>('MAIL_FROM').trim();
    this.fromName = this.appName;
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY')?.trim() || null;
    this.templatesDir = resolveTemplatesDir();

    if (this.brevoApiKey) {
      this.logger.log(`Mail: Brevo HTTPS API (from=${this.fromEmail})`);
    } else {
      const host = this.configService.get<string>('MAIL_HOST');
      const port = this.configService.get<string | number>('MAIL_PORT');
      this.logger.log(`Mail: SMTP ${host}:${port}`);
    }
  }

  async sendPasswordResetEmail(
    to: string,
    data: { firstName: string; resetLink: string },
  ): Promise<MailSendResult> {
    return this.send({
      to,
      subject: 'Reset your password',
      template: 'reset-password',
      context: { ...data, appName: this.appName },
    });
  }

  async sendVerificationEmail(
    to: string,
    data: { firstName: string; verifyLink: string },
  ): Promise<MailSendResult> {
    return this.send({
      to,
      subject: 'Verify your email',
      template: 'verify-email',
      context: { ...data, appName: this.appName },
    });
  }

  async sendInviteEmail(
    to: string,
    data: {
      firstName: string;
      inviterName: string;
      tenantName: string;
      inviteLink: string;
    },
  ): Promise<MailSendResult> {
    return this.send({
      to,
      subject: `You're invited to join ${data.tenantName}`,
      template: 'invite-user',
      context: { ...data, appName: this.appName },
    });
  }

  async sendJoinWorkspaceEmail(
    to: string,
    data: {
      firstName: string;
      inviterName: string;
      tenantName: string;
      loginLink: string;
    },
  ): Promise<MailSendResult> {
    return this.send({
      to,
      subject: `You've been added to ${data.tenantName}`,
      template: 'join-workspace',
      context: { ...data, appName: this.appName },
    });
  }

  private loadHtml(template: string, context: Record<string, unknown>): string {
    const source = readFileSync(join(this.templatesDir, `${template}.hbs`), 'utf8');
    return renderTemplate(source, context);
  }

  private formatMailError(err: unknown): string {
    if (err == null) return 'null/undefined error';
    if (err instanceof Error) {
      const parts = [
        err.name || 'Error',
        err.message || '(empty message)',
        'code' in err ? `code=${String((err as { code?: unknown }).code)}` : null,
      ].filter(Boolean);
      return parts.join(' | ');
    }
    if (typeof err === 'object') {
      try {
        return inspect(err, { depth: 3, breakLength: 120 });
      } catch {
        return String(err);
      }
    }
    return String(err);
  }

  private async sendViaBrevoApi(options: {
    to: string;
    subject: string;
    html: string;
  }): Promise<MailSendResult> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': this.brevoApiKey!,
      },
      body: JSON.stringify({
        sender: { name: this.fromName, email: this.fromEmail },
        to: [{ email: options.to }],
        subject: options.subject,
        htmlContent: options.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { sent: false, error: `Brevo API ${res.status}: ${body.slice(0, 400)}` };
    }
    return { sent: true };
  }

  private async send(options: {
    to: string;
    subject: string;
    template: string;
    context: Record<string, unknown>;
  }): Promise<MailSendResult> {
    try {
      this.logger.log(`Sending "${options.subject}" to ${options.to}…`);

      if (this.brevoApiKey) {
        const html = this.loadHtml(options.template, options.context);
        const result = await this.sendViaBrevoApi({
          to: options.to,
          subject: options.subject,
          html,
        });
        if (result.sent) {
          this.logger.log(`✓ Email sent "${options.subject}" → ${options.to}`);
        } else {
          this.logger.error(`✗ Failed: ${result.error}`);
        }
        return result;
      }

      await this.mailerService.sendMail({
        to: options.to,
        subject: options.subject,
        template: options.template,
        context: options.context,
      });
      this.logger.log(`✓ Email sent "${options.subject}" → ${options.to}`);
      return { sent: true };
    } catch (err: unknown) {
      const error = this.formatMailError(err);
      this.logger.error(`✗ Failed to send "${options.subject}" to ${options.to}: ${error}`);
      return { sent: false, error };
    }
  }
}
