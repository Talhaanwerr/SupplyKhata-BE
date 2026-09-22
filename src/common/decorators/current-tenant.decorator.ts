import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';

interface TenantAwareRequest {
  user?: AuthenticatedUser;
  tenantId?: string;
}

/**
 * Resolves the active tenant for the request.
 * Prefers `req.tenantId` set by TenantGuard (supports super-admin x-tenant-id),
 * otherwise falls back to the authenticated user's tenantId.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<TenantAwareRequest>();
    const tenantId = req.tenantId ?? req.user?.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context is missing');
    }
    return tenantId;
  },
);
