export interface JwtPayload {
  sub: string;
  email: string;
  /** Active tenant for this session. Null for super-admin platform sessions. */
  tenantId: string | null;
  isSuperAdmin: boolean;
}

export interface JwtRefreshPayload extends JwtPayload {
  sessionId: string;
}

/** Short-lived token returned when a user belongs to multiple tenants. */
export interface JwtSelectionPayload {
  sub: string;
  type: 'selection';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  /** Active tenant. Null for super-admin platform-level requests. */
  tenantId: string | null;
  isSuperAdmin: boolean;
  sessionId?: string;
}
