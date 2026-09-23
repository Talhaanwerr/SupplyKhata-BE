import { existsSync } from 'fs';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { join } from 'path';
import { MailService } from './mail.service';

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

@Global()
@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const port = Number(configService.getOrThrow<number>('MAIL_PORT'));
        // 465 = implicit TLS; 587 = STARTTLS (Gmail / Mailtrap)
        const useImplicitTls = port === 465;
        const host = configService.getOrThrow<string>('MAIL_HOST').trim();
        const user = configService.getOrThrow<string>('MAIL_USER').trim();
        // Gmail app passwords are often pasted with spaces — strip all whitespace
        const pass = configService.getOrThrow<string>('MAIL_PASS').replace(/\s+/g, '').trim();
        const fromEmail = configService.getOrThrow<string>('MAIL_FROM').trim();
        const fromName = configService.getOrThrow<string>('MAIL_FROM_NAME').trim();
        return {
          transport: {
            host,
            port,
            secure: useImplicitTls,
            requireTLS: !useImplicitTls,
            // Railway often has broken/unreachable IPv6 to Gmail (ENETUNREACH …::587)
            family: 4,
            auth: { user, pass },
            connectionTimeout: 20_000,
            greetingTimeout: 20_000,
            socketTimeout: 20_000,
          },
          defaults: {
            from: `"${fromName}" <${fromEmail}>`,
          },
          template: {
            dir: resolveTemplatesDir(),
            adapter: new HandlebarsAdapter(),
            options: {
              strict: true,
            },
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
