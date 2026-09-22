import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restrict a route to users who hold all listed permissions.
 * Format: 'module:action' — e.g. 'users:create', 'roles:delete'.
 * Super admins bypass this check automatically.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
