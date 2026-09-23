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
      const errMsg =
        err instanceof Error
          ? err.message || err.name || 'Unknown error'
          : typeof err === 'object' && err !== null
            ? JSON.stringify(err)
            : String(err);
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : undefined;
      this.logger.error(
        `✗ Failed to send "${options.subject}" to ${options.to}: ${errMsg}${code ? ` (code=${code})` : ''}`,
      );
      if (err instanceof Error && err.stack) {
        this.logger.error(err.stack);
      }
      return false;
    }
  }
}
