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
        // 465 = implicit TLS; 587 = STARTTLS (Mailtrap / most SMTP)
        const useImplicitTls = port === 465;
        return {
          transport: {
            host: configService.getOrThrow<string>('MAIL_HOST'),
            port,
            secure: useImplicitTls,
            requireTLS: !useImplicitTls,
            auth: {
              user: configService.getOrThrow<string>('MAIL_USER'),
              pass: configService.getOrThrow<string>('MAIL_PASS'),
            },
            connectionTimeout: 20_000,
            greetingTimeout: 20_000,
            socketTimeout: 20_000,
          },
          defaults: {
            from: `"${configService.getOrThrow<string>('MAIL_FROM_NAME')}" <${configService.getOrThrow<string>('MAIL_FROM')}>`,
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
