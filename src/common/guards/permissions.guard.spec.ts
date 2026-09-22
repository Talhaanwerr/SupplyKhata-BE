import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PrismaService } from '../../prisma/prisma.service';

function makeCtx(user: unknown): ExecutionContext {
  const req = { user };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

// Prisma mock — cast through unknown to avoid strict type mismatch with Prisma delegates
const userRoleFindMany = jest.fn();
const mockPrisma = { userRole: { findMany: userRoleFindMany } } as unknown as PrismaService;

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    jest.clearAllMocks();
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new PermissionsGuard(reflector, mockPrisma);
  });

  it('passes when no permissions are required', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(await guard.canActivate(makeCtx({}))).toBe(true);
  });

  it('passes for super admin regardless of permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users:delete']);
    const result = await guard.canActivate(
      makeCtx({ id: 'su', tenantId: 'tenant-1', isSuperAdmin: true }),
    );
    expect(result).toBe(true);
    expect(userRoleFindMany).not.toHaveBeenCalled();
  });

  it('returns false when no user', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users:read']);
    expect(await guard.canActivate(makeCtx(undefined))).toBe(false);
  });

  it('passes when user has all required permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users:read', 'roles:read']);
    userRoleFindMany.mockResolvedValue([
      {
        role: {
          permissions: [
            { permission: { module: 'users', action: 'read' } },
            { permission: { module: 'roles', action: 'read' } },
          ],
        },
      },
    ]);

    const result = await guard.canActivate(
      makeCtx({ id: 'u1', tenantId: 'tenant-1', isSuperAdmin: false }),
    );
    expect(result).toBe(true);
  });

  it('throws ForbiddenException when user is missing a permission', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users:delete']);
    userRoleFindMany.mockResolvedValue([
      { role: { permissions: [{ permission: { module: 'users', action: 'read' } }] } },
    ]);

    await expect(
      guard.canActivate(makeCtx({ id: 'u1', tenantId: 'tenant-1', isSuperAdmin: false })),
    ).rejects.toThrow(ForbiddenException);
  });
});
