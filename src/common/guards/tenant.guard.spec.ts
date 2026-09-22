import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantGuard } from './tenant.guard';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';

function makeCtx(
  user: unknown,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): ExecutionContext {
  const req = { user, params, headers, tenantId: undefined as string | undefined };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('TenantGuard', () => {
  let guard: TenantGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    guard = new TenantGuard(reflector);
  });

  it('returns false when no user is present', () => {
    const ctx = makeCtx(undefined);
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('allows @Public() routes without a user', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      return key === IS_PUBLIC_KEY ? true : undefined;
    });
    const ctx = makeCtx(undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows regular user and sets tenantId on request', () => {
    const user = { id: 'u1', tenantId: 'tenant-1', isSuperAdmin: false };
    const ctx = makeCtx(user);
    const req = ctx.switchToHttp().getRequest() as { tenantId?: string };

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenantId).toBe('tenant-1');
  });

  it('throws ForbiddenException when param tenantId mismatches user tenantId', () => {
    const user = { id: 'u1', tenantId: 'tenant-1', isSuperAdmin: false };
    const ctx = makeCtx(user, { tenantId: 'tenant-99' });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws BadRequestException when regular user has no tenantId', () => {
    const user = { id: 'u1', tenantId: '', isSuperAdmin: false };
    const ctx = makeCtx(user);

    expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
  });

  it('allows super admin and uses own tenantId when no header', () => {
    const user = { id: 'su1', tenantId: 'platform', isSuperAdmin: true };
    const ctx = makeCtx(user);
    const req = ctx.switchToHttp().getRequest() as { tenantId?: string };

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenantId).toBe('platform');
  });

  it('allows super admin to override tenantId via x-tenant-id header', () => {
    const user = { id: 'su1', tenantId: 'platform', isSuperAdmin: true };
    const ctx = makeCtx(user, {}, { 'x-tenant-id': 'tenant-override' });
    const req = ctx.switchToHttp().getRequest() as { tenantId?: string };

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenantId).toBe('tenant-override');
  });
});
