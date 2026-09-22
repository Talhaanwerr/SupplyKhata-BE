import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';
import { ROLES_KEY } from '../decorators/roles.decorator';

type UserRoleSlugRow = {
  role: { slug: string };
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) return true;

    const user = context.switchToHttp().getRequest<Request>().user as AuthenticatedUser | undefined;
    if (!user) return false;

    // Super admin bypasses all role checks
    if (user.isSuperAdmin) return true;

    if (!user.tenantId) return false; // no tenant context → no role-based access

    const userRoles = (await this.prisma.userRole.findMany({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { role: { select: { slug: true } } },
    })) as UserRoleSlugRow[];

    const slugs = new Set(userRoles.map((ur) => ur.role.slug));
    const allowed = requiredRoles.some((r) => slugs.has(r));

    if (!allowed) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
