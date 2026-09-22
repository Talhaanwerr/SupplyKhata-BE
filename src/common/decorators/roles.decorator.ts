import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Apply to a controller or route to restrict access to specific role slugs. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
