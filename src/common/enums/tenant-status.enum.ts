/** Mirrors Prisma `TenantStatus` — kept local so DTOs/services don't depend on generated client stubs. */
export enum TenantStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
}
