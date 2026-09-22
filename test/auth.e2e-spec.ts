/**
 * E2E tests for Auth endpoints.
 *
 * These tests run against a real NestJS application with a mocked PrismaService
 * to keep them fast and database-independent.
 *
 * To run against a real DB, swap the PrismaService mock for a test DB connection
 * and run `npm run test:e2e`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import * as request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ─── Minimal Prisma mock for e2e ──────────────────────────────────────────────

const e2ePrisma = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  userSession: {
    create: jest.fn().mockResolvedValue({ id: 'session-e2e' }),
    findFirst: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  loginAttempt: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
  role: { findMany: jest.fn() },
  userRole: { findMany: jest.fn().mockResolvedValue([]) },
  tenant: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  auditLog: { create: jest.fn() },
  tenantSettings: { upsert: jest.fn() },
  $connect: jest.fn(),
  $disconnect: jest.fn(),
};

describe('Auth (e2e)', () => {
  let app: INestApplication;

  const activeUser = {
    id: 'e2e-user',
    email: 'test@acme.com',
    tenantId: 'tenant-e2e',
    passwordHash: 'hashed',
    status: 'ACTIVE',
    emailVerified: true,
    isSuperAdmin: false,
    firstName: 'Test',
    lastName: 'User',
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(e2ePrisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  // ─── POST /auth/login ──────────────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    it('returns 401 for invalid credentials', async () => {
      e2ePrisma.user.findFirst.mockResolvedValue(null);
      jest.spyOn(argon2, 'verify').mockResolvedValue(false);

      return request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@x.com', password: 'WrongP@ss1' })
        .expect(401);
    });

    it('returns 200 and tokens for valid credentials', async () => {
      e2ePrisma.user.findFirst.mockResolvedValue(activeUser);
      jest.spyOn(argon2, 'verify').mockResolvedValue(true);
      jest.spyOn(argon2, 'hash').mockResolvedValue('hashed-rt');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'test@acme.com', password: 'StrongP@ss1' })
        .expect(200);

      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
    });

    it('returns 400 for missing fields', async () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('returns 403 when account is locked out', async () => {
      e2ePrisma.loginAttempt.count.mockResolvedValue(10); // exceeds maxAttempts

      return request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'locked@acme.com', password: 'StrongP@ss1' })
        .expect(403);
    });
  });

  // ─── GET /auth/me ──────────────────────────────────────────────────────────

  describe('GET /api/v1/auth/me', () => {
    it('returns 401 without a token', () => {
      return request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    });
  });

  // ─── POST /auth/forgot-password ────────────────────────────────────────────

  describe('POST /api/v1/auth/forgot-password', () => {
    it('always returns 200 regardless of whether email exists', async () => {
      e2ePrisma.user.findFirst.mockResolvedValue(null);

      return request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'ghost@acme.com' })
        .expect(200);
    });
  });
});
