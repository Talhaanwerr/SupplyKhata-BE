/** Mirrors Prisma `CustomerStatus` — kept local so DTOs/services don't depend on generated client stubs. */
export enum CustomerStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/** Mirrors Prisma `PaymentCycle` — kept local so DTOs/services don't depend on generated client stubs. */
export enum PaymentCycle {
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  WEEKLY = 'WEEKLY',
  FORTNIGHTLY = 'FORTNIGHTLY',
  MONTHLY = 'MONTHLY',
  CUSTOM = 'CUSTOM',
}
