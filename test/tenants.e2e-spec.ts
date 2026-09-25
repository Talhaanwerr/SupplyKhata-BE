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
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

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
  tenantMember: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  userSession: {
    create: jest.fn(),
    update: jest.fn(),
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
    delete: jest.fn(),
  },
  role: { findMany: jest.fn(), findFirst: jest.fn() },
  userRole: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
  auditLog: { create: jest.fn() },
  tenantSettings: { upsert: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
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
      tenantId: null,
      isSuperAdmin: true,
    });

  const tenantUserToken = (tenantId: string) =>
    jwtService.sign({
      sub: 'user-e2e',
      email: 'user@acme.com',
      tenantId,
      isSuperAdmin: false,
    });

  /** JwtStrategy loads the user (and membership for non-SA). */
  const mockSuperAdminAuth = () => {
    e2ePrisma.user.findUnique.mockResolvedValue({
      id: 'super-admin-e2e',
      email: 'sa@platform.com',
      isSuperAdmin: true,
    });
  };

  const mockTenantUserAuth = (_tenantId?: string) => {
    e2ePrisma.user.findUnique.mockResolvedValue({
      id: 'user-e2e',
      email: 'user@acme.com',
      isSuperAdmin: false,
    });
    e2ePrisma.tenantMember.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      tenant: { status: 'ACTIVE', deletedAt: null },
    });
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
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    jwtService = moduleRef.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => jest.clearAllMocks());

  // ─── GET /tenants ──────────────────────────────────────────────────────────

  describe('GET /api/v1/tenants', () => {
    it('returns 401 without a token', () => {
      return request(app.getHttpServer()).get('/api/v1/tenants').expect(401);
    });

    it('returns 403 for non-super-admin users', () => {
      mockTenantUserAuth('tenant-1');

      return request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .expect(403);
    });

    it('returns 200 for super admin', () => {
      mockSuperAdminAuth();
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
      mockTenantUserAuth('tenant-1');

      return request(app.getHttpServer())
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .send({
          name: 'New Corp',
          slug: 'new-corp',
          ownerEmail: 'owner@newcorp.com',
          ownerFirstName: 'Jane',
          ownerLastName: 'Doe',
        })
        .expect(403);
    });

    it('returns 400 when owner fields are missing', async () => {
      mockSuperAdminAuth();

      return request(app.getHttpServer())
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${superAdminToken()}`)
        .send({ name: 'New Corp', slug: 'new-corp' })
        .expect(400);
    });
  });

  // ─── Tenant isolation ─────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('tenant user cannot list other tenants', () => {
      mockTenantUserAuth('tenant-A');

      return request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-A')}`)
        .expect(403);
    });

    it('permission denied returns 403 not 500', async () => {
      mockTenantUserAuth('tenant-1');

      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${tenantUserToken('tenant-1')}`)
        .expect(403);

      expect(res.body).not.toHaveProperty('stack');
      expect(res.body.success).toBe(false);
      expect(typeof res.body.message).toBe('string');
    });
  });
});
