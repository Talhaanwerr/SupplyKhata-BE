import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';

interface TenantRequest {
  user?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  tenantId?: string | null;
}

/**
 * Ensures every tenant-scoped request carries a valid tenantId.
 *
 * - Super admins may pass an explicit `x-tenant-id` header to act on a specific tenant.
 * - Regular users may only access their own tenant's data.
 * - If neither source provides a tenantId, the request is rejected.
 * - `@Public()` routes skip tenant checks (e.g. public avatar/file content).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const user = req.user;

    if (!user) return false;

    if (user.isSuperAdmin) {
      const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
      if (headerTenantId) {
        // Allow super admin to scope to a tenant via header
        req['tenantId'] = headerTenantId;
        return true;
      }
      // Super admins without a header can still proceed (platform-level route)
      req['tenantId'] = user.tenantId;
      return true;
    }

    if (!user.tenantId) {
      throw new BadRequestException('Tenant context is missing');
    }

    // Prevent cross-tenant access: if the route param tenantId doesn't match, reject
    const paramTenantId = (req.params as Record<string, string>)['tenantId'];
    if (paramTenantId && paramTenantId !== user.tenantId) {
      throw new ForbiddenException('Access to this tenant is not allowed');
    }

    req['tenantId'] = user.tenantId;
    return true;
  }
}
