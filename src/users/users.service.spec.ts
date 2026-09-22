import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { MailService } from '../mail/mail.service';

const TENANT_ID = 'tenant-1';
const ACTOR_ID = 'admin-1';

const baseUser = {
  id: 'user-1',
  tenantId: TENANT_ID,
  email: 'alice@acme.com',
  firstName: 'Alice',
  lastName: 'Smith',
  status: 'ACTIVE',
  emailVerified: true,
  avatarUrl: null,
  timezone: null,
  isSuperAdmin: false,
  invitedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockPrisma = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  userRole: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
  role: { findMany: jest.fn() },
  userSession: { deleteMany: jest.fn(), create: jest.fn() },
  tenant: { findUnique: jest.fn() },
};

const mockAudit = { write: jest.fn() };
const mockMail = { sendInviteEmail: jest.fn() };
const mockConfig = {
  getOrThrow: jest.fn().mockReturnValue('http://localhost:3001'),
  get: jest.fn().mockReturnValue('http://localhost:3001'),
};

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogsService, useValue: mockAudit },
        { provide: MailService, useValue: mockMail },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a user successfully', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null); // email unique check
      mockPrisma.user.create.mockResolvedValue(baseUser);
      jest.spyOn(argon2, 'hash').mockResolvedValue('hashed');

      const result = await service.create(
        { email: 'alice@acme.com', firstName: 'Alice', lastName: 'Smith', password: 'StrongP@ss1' },
        TENANT_ID,
        ACTOR_ID,
      );

      expect(result.email).toBe('alice@acme.com');
      expect(mockAudit.write).toHaveBeenCalled();
    });

    it('throws ConflictException when email already exists', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(baseUser); // email taken

      await expect(
        service.create(
          { email: 'alice@acme.com', firstName: 'A', lastName: 'S', password: 'StrongP@ss1' },
          TENANT_ID,
          ACTOR_ID,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns user with roles', async () => {
      const userWithRoles = {
        ...baseUser,
        emailVerifiedAt: null,
        roles: [
          {
            id: 'ur-1',
            tenantId: TENANT_ID,
            createdAt: new Date(),
            role: { id: 'r1', name: 'Viewer', slug: 'viewer', isSystem: true },
          },
        ],
      };
      mockPrisma.user.findFirst.mockResolvedValue(userWithRoles);

      const result = await service.findOne('user-1', TENANT_ID);
      expect(result.email).toBe('alice@acme.com');
      expect(result.roles).toHaveLength(1);
      expect((result.roles[0] as unknown as { slug: string }).slug).toBe('viewer');
    });

    it('throws NotFoundException when user not in tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.findOne('user-1', TENANT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── deactivate ───────────────────────────────────────────────────────────

  describe('deactivate', () => {
    it('deactivates an active user and invalidates sessions', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(baseUser);
      mockPrisma.user.update.mockResolvedValue({ ...baseUser, status: 'INACTIVE' });
      mockPrisma.userSession.deleteMany.mockResolvedValue({ count: 1 });

      await service.deactivate('user-1', TENANT_ID, ACTOR_ID);

      expect(mockPrisma.userSession.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(mockAudit.write).toHaveBeenCalled();
    });

    it('throws BadRequestException when user tries to deactivate themselves', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ ...baseUser, id: ACTOR_ID });

      await expect(service.deactivate(ACTOR_ID, TENANT_ID, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException for user from another tenant', async () => {
      // findFirst returns null because tenantId filter won't match
      mockPrisma.user.findFirst.mockResolvedValue(null);

      await expect(service.deactivate('user-x', 'other-tenant', ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── Cross-tenant isolation ───────────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('cannot find users from another tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);

      await expect(service.findOne('user-1', 'wrong-tenant')).rejects.toThrow(NotFoundException);
    });
  });
});
