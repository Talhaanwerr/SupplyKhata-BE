import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

// ─── Minimal stubs ─────────────────────────────────────────────────────────────

const mockPrisma = {
  user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  userSession: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  loginAttempt: { count: jest.fn(), create: jest.fn() },
};

const mockJwt = { sign: jest.fn().mockReturnValue('signed-token') };

const mockConfig = {
  getOrThrow: jest.fn((key: string) => {
    const map: Record<string, string | number> = {
      LOGIN_MAX_ATTEMPTS: 5,
      LOGIN_LOCKOUT_MINUTES: 15,
      FRONTEND_URL: 'http://localhost:3001',
      API_PUBLIC_URL: 'http://localhost:4700',
      JWT_REFRESH_EXPIRES_IN: '7d',
      JWT_REFRESH_SECRET: 'refresh-secret',
    };
    return map[key];
  }),
  get: jest.fn((key: string, fallback?: string) => {
    if (key === 'UPLOAD_DIR') return './uploads';
    return fallback;
  }),
};

const mockMail = { sendPasswordResetEmail: jest.fn(), sendVerificationEmail: jest.fn() };

// ─── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: MailService, useValue: mockMail },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ─── login ───────────────────────────────────────────────────────────────

  describe('login', () => {
    const dto = { email: 'alice@acme.com', password: 'StrongP@ss1' };

    const activeUser = {
      id: 'user-1',
      email: dto.email,
      tenantId: 'tenant-1',
      passwordHash: 'hashed',
      status: 'ACTIVE',
      emailVerified: true,
      isSuperAdmin: false,
      firstName: 'Alice',
      lastName: 'Smith',
    };

    beforeEach(() => {
      // No lockout by default
      mockPrisma.loginAttempt.count.mockResolvedValue(0);
      mockPrisma.loginAttempt.create.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({ id: 'session-1' });
    });

    it('returns tokens for valid credentials', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(activeUser);

      // Patch argon2.verify via module internals — use a spy on the hash comparison
      jest.spyOn(argon2, 'verify').mockResolvedValue(true);

      const result = await service.login(dto);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      if (!('requiresTenantSelection' in result) && !('totpRequired' in result)) {
        expect(result.user?.email).toBe(dto.email);
      }
    });

    it('throws UnauthorizedException for wrong password', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(activeUser);
      jest.spyOn(argon2, 'verify').mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user does not exist', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      jest.spyOn(argon2, 'verify').mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when account is suspended', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ ...activeUser, status: 'SUSPENDED' });
      jest.spyOn(argon2, 'verify').mockResolvedValue(true);

      await expect(service.login(dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when email not verified', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ ...activeUser, emailVerified: false });
      jest.spyOn(argon2, 'verify').mockResolvedValue(true);

      await expect(service.login(dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when account is locked', async () => {
      mockPrisma.loginAttempt.count.mockResolvedValue(5); // maxAttempts reached

      await expect(service.login(dto)).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── refreshTokens ───────────────────────────────────────────────────────

  describe('refreshTokens', () => {
    const userWithToken = {
      id: 'user-1',
      email: 'alice@acme.com',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      sessionId: 'session-1',
      rawRefreshToken: 'raw-token',
    };

    it('rotates tokens for valid session', async () => {
      const session = {
        id: 'session-1',
        userId: 'user-1',
        refreshTokenHash: 'hashed-rt',
        expiresAt: new Date(Date.now() + 60000),
      };

      mockPrisma.userSession.findFirst.mockResolvedValue(session);
      mockPrisma.userSession.delete.mockResolvedValue(session);
      mockPrisma.userSession.create.mockResolvedValue({ id: 'session-2' });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@acme.com',
        tenantId: 'tenant-1',
        isSuperAdmin: false,
        status: 'ACTIVE',
      });

      jest.spyOn(argon2, 'verify').mockResolvedValue(true);
      jest.spyOn(argon2, 'hash').mockResolvedValue('new-hash');

      const result = await service.refreshTokens(userWithToken);
      expect(result).toHaveProperty('accessToken');
    });

    it('throws UnauthorizedException for expired session', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'session-1',
        expiresAt: new Date(Date.now() - 1000), // expired
      });

      await expect(service.refreshTokens(userWithToken)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException and clears all sessions on token mismatch', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'session-1',
        refreshTokenHash: 'hashed-rt',
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.userSession.deleteMany.mockResolvedValue({ count: 1 });

      jest.spyOn(argon2, 'verify').mockResolvedValue(false);

      await expect(service.refreshTokens(userWithToken)).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.userSession.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });
  });

  // ─── logout ──────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('deletes the session', async () => {
      mockPrisma.userSession.deleteMany.mockResolvedValue({ count: 1 });
      await service.logout('session-1');
      expect(mockPrisma.userSession.deleteMany).toHaveBeenCalledWith({
        where: { id: 'session-1' },
      });
    });
  });
});
