/**
 * E2E tests for Tenants endpoints.
 * Tests tenant isolation and permission enforcement.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const e2ePrisma = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  userSession: {
    create: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  loginAttempt: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
  tenant: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  role: { findMany: jest.fn() },
  userRole: { findMany: jest.fn().mockResolvedValue([]) },
  auditLog: { create: jest.fn() },
  tenantSettings: { upsert: jest.fn() },
  $connect: jest.fn(),
  $disconnect: jest.fn(),
};

describe('Tenants (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  const superAdminToken = () =>
    jwtService.sign({
      sub: 'super-admin-e2e',
      email: 'sa@platform.com',
      tenantId: 'platform',
      isSuperAdmin: true,
    });

  const tenantUserToken = (tenantId: string) =>
    jwtService.sign({
      sub: 'user-e2e',
      email: 'user@acme.com',
      tenantId,
      isSuperAdmin: false,
    });

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

    jwtService = moduleRef.get<JwtService>(JwtService);
  });

  afterAll(async () => await app.close());
  beforeEach(() => jest.clearAllMocks());

  // ─── GET /tenants ──────────────────────────────────────────────────────────

  describe('GET /api/v1/tenants', () => {
    it('returns 401 without a token', () => {
      return request(app.getHttpServer()).get('/api/v1/tenants').expect(401);
    });

    it('returns 403 for non-super-admin users', () => {
      return request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .expect(403);
    });

    it('returns 200 for super admin', () => {
      e2ePrisma.tenant.findMany.mockResolvedValue([]);
      e2ePrisma.tenant.count.mockResolvedValue(0);

      return request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${superAdminToken()}`)
        .expect(200);
    });
  });

  // ─── POST /tenants ─────────────────────────────────────────────────────────

  describe('POST /api/v1/tenants', () => {
    it('returns 403 for regular tenant user', () => {
      return request(app.getHttpServer())
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .send({ name: 'New Corp', slug: 'new-corp' })
        .expect(403);
    });

    it('creates a tenant for super admin', async () => {
      e2ePrisma.tenant.findFirst.mockResolvedValue(null);
      e2ePrisma.tenant.create.mockResolvedValue({
        id: 't-new',
        name: 'New Corp',
        slug: 'new-corp',
        status: 'PENDING',
        domain: null,
        subdomain: null,
        ownerUserId: null,
        timezone: 'UTC',
        currency: 'USD',
        logo: null,
        createdAt: new Date(),
      });

      return request(app.getHttpServer())
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${superAdminToken()}`)
        .send({ name: 'New Corp', slug: 'new-corp' })
        .expect(201);
    });
  });

  // ─── Tenant isolation ─────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('tenant user cannot list other tenants', () => {
      // /tenants endpoint is super admin only — any tenant user gets 403
      return request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-A')}`)
        .expect(403);
    });

    it('permission denied returns 403 not 500', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .expect(403);

      // Response must never expose stack traces or internal details
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body.success).toBe(false);
      expect(typeof res.body.message).toBe('string');
    });
  });
});
