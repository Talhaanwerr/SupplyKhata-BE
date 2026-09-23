import { inspect } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly appName: string;

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    this.appName = this.configService.getOrThrow<string>('MAIL_FROM_NAME');
    const host = this.configService.get<string>('MAIL_HOST');
    const port = this.configService.get<string | number>('MAIL_PORT');
    this.logger.log(`Mail transport configured: ${host}:${port}`);
  }

  async sendPasswordResetEmail(
    to: string,
    data: { firstName: string; resetLink: string },
  ): Promise<boolean> {
    return this.send({
      to,
      subject: 'Reset your password',
      template: 'reset-password',
      context: {
        ...data,
        appName: this.appName,
      },
    });
  }

  async sendVerificationEmail(
    to: string,
    data: { firstName: string; verifyLink: string },
  ): Promise<boolean> {
    return this.send({
      to,
      subject: 'Verify your email',
      template: 'verify-email',
      context: {
        ...data,
        appName: this.appName,
      },
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
  ): Promise<boolean> {
    return this.send({
      to,
      subject: `You're invited to join ${data.tenantName}`,
      template: 'invite-user',
      context: {
        ...data,
        appName: this.appName,
      },
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
  ): Promise<boolean> {
    return this.send({
      to,
      subject: `You've been added to ${data.tenantName}`,
      template: 'join-workspace',
      context: {
        ...data,
        appName: this.appName,
      },
    });
  }

  private formatMailError(err: unknown): string {
    if (err == null) return 'null/undefined error';

    if (err instanceof Error) {
      const parts = [
        err.name || 'Error',
        err.message || '(empty message)',
        'code' in err ? `code=${String((err as { code?: unknown }).code)}` : null,
        'command' in err ? `command=${String((err as { command?: unknown }).command)}` : null,
        'response' in err ? `response=${String((err as { response?: unknown }).response)}` : null,
        'responseCode' in err
          ? `responseCode=${String((err as { responseCode?: unknown }).responseCode)}`
          : null,
      ].filter(Boolean);
      return parts.join(' | ');
    }

    if (typeof err === 'object') {
      try {
        return inspect(err, { depth: 4, breakLength: 120 });
      } catch {
        return String(err);
      }
    }

    return String(err);
  }

  private async send(options: {
    to: string;
    subject: string;
    template: string;
    context: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      this.logger.log(`Sending "${options.subject}" to ${options.to}…`);
      await this.mailerService.sendMail({
        to: options.to,
        subject: options.subject,
        template: options.template,
        context: options.context,
      });
      this.logger.log(`✓ Email sent "${options.subject}" → ${options.to}`);
      return true;
    } catch (err: unknown) {
      this.logger.error(
        `✗ Failed to send "${options.subject}" to ${options.to}: ${this.formatMailError(err)}`,
      );
      return false;
    }
  }
}
