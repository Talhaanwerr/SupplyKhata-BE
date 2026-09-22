import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UsersService } from '../users/users.service';
import { TenantStatus } from '../common/enums/tenant-status.enum';

const ACTOR_ID = 'super-admin-1';

const baseTenant = {
  id: 'tenant-1',
  name: 'Acme Corp',
  slug: 'acme',
  domain: null,
  subdomain: 'acme',
  status: TenantStatus.ACTIVE,
  ownerUserId: 'owner-1',
  timezone: 'Asia/Karachi',
  currency: 'PKR',
  logo: null,
  createdAt: new Date(),
};

const mockPrisma = {
  tenant: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  role: { findFirst: jest.fn() },
  tenantSettings: { create: jest.fn(), deleteMany: jest.fn() },
  tenantMember: { deleteMany: jest.fn() },
  userRole: { deleteMany: jest.fn() },
};

const mockAudit = { write: jest.fn() };
const mockUsers = {
  invite: jest.fn().mockResolvedValue({
    id: 'owner-1',
    email: 'owner@acme.com',
    firstName: 'Jane',
    lastName: 'Doe',
  }),
};

describe('TenantsService', () => {
  let service: TenantsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogsService, useValue: mockAudit },
        { provide: UsersService, useValue: mockUsers },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
  });

  describe('create', () => {
    const dto = {
      name: 'Acme Corp',
      slug: 'acme',
      subdomain: 'acme',
      ownerEmail: 'owner@acme.com',
      ownerFirstName: 'Jane',
      ownerLastName: 'Doe',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
    };

    it('creates a tenant and invites the owner', async () => {
      mockPrisma.tenant.findFirst.mockResolvedValue(null); // name unique
      mockPrisma.tenant.findUnique.mockResolvedValue(null); // slug + subdomain unique
      mockPrisma.role.findFirst.mockResolvedValue({ id: 'role-owner' });
      mockPrisma.tenant.create.mockResolvedValue({
        ...baseTenant,
        status: TenantStatus.PENDING,
        ownerUserId: null,
      });
      mockPrisma.tenantSettings.create.mockResolvedValue({});
      mockPrisma.tenant.update.mockResolvedValue({
        ...baseTenant,
        status: TenantStatus.PENDING,
      });

      const result = await service.create(dto, ACTOR_ID);
      expect(result.slug).toBe('acme');
      expect(result.owner.email).toBe('owner@acme.com');
      expect(mockPrisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TenantStatus.PENDING }),
        }),
      );
      expect(mockUsers.invite).toHaveBeenCalled();
      expect(mockAudit.write).toHaveBeenCalled();
    });

    it('throws when tenant_owner role is missing', async () => {
      mockPrisma.tenant.findFirst.mockResolvedValue(null);
      mockPrisma.tenant.findUnique.mockResolvedValue(null);
      mockPrisma.role.findFirst.mockResolvedValue(null);

      await expect(service.create(dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when slug already exists', async () => {
      mockPrisma.tenant.findFirst.mockResolvedValue(baseTenant);

      await expect(service.create(dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when missing', async () => {
      mockPrisma.tenant.findFirst.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
