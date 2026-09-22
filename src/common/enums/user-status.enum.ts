/** Mirrors Prisma `MemberStatus` — per-tenant membership status. */
export enum MemberStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/**
 * @deprecated Renamed to MemberStatus. Use MemberStatus going forward.
 * Kept as an alias so existing DTO imports compile without changes.
 */
export { MemberStatus as UserStatus };
