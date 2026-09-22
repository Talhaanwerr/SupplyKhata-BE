import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Access restricted to super admins');
    }

    return true;
  }
}
