import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import helmet from 'helmet';
import * as express from 'express';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const configService = app.get(ConfigService);
  const port = configService.getOrThrow<number>('PORT');
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const corsOrigins = configService
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const swaggerEnabled = configService.get<string>('SWAGGER_ENABLED', 'true') === 'true';
  const isProduction = nodeEnv === 'production';

  // Swagger UI is served from this same API host; allow its origin in non-prod
  // so "Try it out" requests are not blocked by CORS.
  if (swaggerEnabled && !isProduction) {
    const swaggerOrigin = `http://localhost:${port}`;
    if (!corsOrigins.includes(swaggerOrigin)) {
      corsOrigins.push(swaggerOrigin);
    }
  }

  // Use Winston logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  // Security: Helmet — strict headers including CSP
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? undefined // let helmet use strict defaults in prod
        : false, // disable CSP in dev to allow Swagger UI
      crossOriginEmbedderPolicy: isProduction,
      // Allow FE (different origin) to load public avatars/files via <img>
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Security: Strict CORS — only allow configured origins
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (server-to-server, curl, health checks)
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Request-ID'],
    credentials: true,
  });

  // Cookie parsing — required for httpOnly refresh token support
  app.use(cookieParser());

  // Request body size limits — 1 MB is sufficient for all JSON payloads; file
  // uploads bypass this limit because multipart is handled by multer separately.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // API versioning under /api/v1
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Global validation pipe — whitelist, forbid extra props, transform types
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  // Global JWT guard — all routes require auth by default; use @Public() to opt out
  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector));

  // Global exception filter — no stack traces or internal details to client
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global response interceptor — consistent success envelope
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Swagger — only enabled in non-production; add basic auth in staging
  if (swaggerEnabled && !isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SaaS Boilerplate API')
      .setDescription('Multi-tenant SaaS backend API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      // Apply Bearer to all operations so Authorize actually sends the token
      // (without this, only controllers with @ApiBearerAuth get the header)
      .addSecurityRequirements('access-token')
      .addServer(`http://localhost:${port}`, 'Local')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        // Never send credentials to third-party servers in Swagger UI
        requestInterceptor: '(req) => { req.credentials = "same-origin"; return req; }',
      },
    });
  }

  // Bind 0.0.0.0 so Railway/Docker proxies can reach the process
  await app.listen(port, '0.0.0.0');

  console.log(`Application running on: http://0.0.0.0:${port}/api/v1`);
  if (swaggerEnabled && !isProduction) {
    console.log(`Swagger docs: http://localhost:${port}/api/docs`);
  }
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
