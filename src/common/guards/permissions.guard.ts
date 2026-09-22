import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

type UserRolePermissionRow = {
  role: {
    permissions: {
      permission: { module: string; action: string };
    }[];
  };
};

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest<Request>().user as AuthenticatedUser | undefined;
    if (!user) return false;

    // Super admin bypasses all permission checks
    if (user.isSuperAdmin) return true;

    if (!user.tenantId) return false; // no tenant context → no permissions

    const userRoles = (await this.prisma.userRole.findMany({
      where: { userId: user.id, tenantId: user.tenantId },
      select: {
        role: {
          select: {
            permissions: {
              select: {
                permission: { select: { module: true, action: true } },
              },
            },
          },
        },
      },
    })) as UserRolePermissionRow[];

    const granted = new Set(
      userRoles.flatMap((ur) =>
        ur.role.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
      ),
    );

    const allowed = required.every((p) => granted.has(p));
    if (!allowed) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
