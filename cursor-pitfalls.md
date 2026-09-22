# Cursor Pitfalls

Rules to follow on every new module. Read before touching auth, guards, API, forms, or env.


## Guards and Tenant Context

- Never put `TenantGuard` at class level on a controller that Super Admins also call.
  SA has no `tenantId` in their JWT — `@CurrentTenant()` will throw `400 Tenant context is missing`.
  Rule: apply `TenantGuard` only at method level on routes that need a real tenant.
  For SA-accessible routes, read `user.tenantId` from `@CurrentUser()` and handle null gracefully.

- Never use `@CurrentTenant()` on a route that SA will call. Use `user.tenantId ?? ''` from `@CurrentUser()` instead.


## API Endpoints

- Every resource that only regular users need a tenant for must still have a SA-safe variant or skip the guard.
  Example: profile update uses `PATCH /auth/me` (JwtAuthGuard only), not `PATCH /users/:id` (which has TenantGuard).

- Login DTOs must NOT have `@MinLength`, password complexity rules, or any strength validation.
  Password strength belongs only on register, reset-password, change-password, and accept-invite flows.

- `/auth/refresh` body field must be optional. The real refresh token comes from the httpOnly cookie.
  A required body field causes `400` on every silent token refresh and breaks session restore.

- When adding a new uniqueness constraint (slug, name, subdomain), add it as a private `assertXxxUnique` helper
  and call it in BOTH `create` and `update`. Slug-only uniqueness is never enough for human-readable fields like name.

- Stats and counts must come from real DB queries. Never return hardcoded or placeholder values in list/stats endpoints.

- Uniqueness checks (`assertSlugUnique`, `assertNameUnique`, `assertSubdomainUnique`) must always include `deletedAt: null` in the where clause. Without it, soft-deleted records block re-use of the same slug/name, causing false 409 Conflict errors.

- Soft-delete alone does NOT free up DB-level unique constraints (e.g. `tenants_slug_key`). MySQL has no partial index support. When soft-deleting a record that has a unique field, mangle the field value at delete time — e.g. append `_deleted_<Date.now()>` to slug and subdomain — so the original value is immediately available for reuse.


## Frontend API Client

- The API client must NOT retry or redirect on `401` for auth routes: login, refresh, forgot-password, reset-password, verify-email, select-tenant.
  These routes return legitimate 4xx errors that the UI must display inline.

- When the request body is `FormData`, do NOT set `Content-Type: application/json` and do NOT JSON-stringify the body.
  Let the browser set `multipart/form-data` with the correct boundary automatically.


## Storage

- Never construct `S3StorageProvider` (or call `config.getOrThrow('S3_BUCKET')`) unless `STORAGE_DRIVER=s3`.
  Local mode must start with all S3 env vars missing.

- Block `image/svg+xml` uploads by default. SVG can carry scripts — XSS risk when served from the same origin.


## CSP

- `connect-src` must list the API **origin** only: `http://localhost:4700`.
  Do not include the path `/api/v1` — CSP origin matching is exact and a path suffix blocks all requests.


## Frontend Routing

- Super Admin must never land on a tenant-scoped page. Check `user.isSuperAdmin` in `UserMenu` and similar
  navigation before building hrefs. SA profile → `/super-admin/profile`, tenant user → `/profile`.

- After any full-page redirect (e.g. post-login), call `initialize()` on app mount via `AuthProvider`.
  The in-memory access token is lost on navigation — without this, every API call returns `401`
  and the user appears to be logged out even though the refresh cookie is valid.


## Forms

- Do not show the `required` asterisk (`required` prop on `FormField`) on login forms.
  It is visual noise when all fields are obviously required. Use `required` only when a form has a mix of required and optional fields.

- FE forms must validate money/number fields with Zod (field-level errors) before calling the API.
  Do not depend on HTML `min`/`max` alone — that shows browser tooltips and skips app validation.
  Mirror constraints on DTOs: `@Min(0)` plus `@IsNumber({ maxDecimalPlaces: 2 })` for money, or `@IsInt()` `@Min(0)` for whole-number amounts (e.g. containerDeposit).


## SupplyKhata Domain Rules

Read before touching delivery, ledger, container, pricing, products, or usage code.

- Delivery creation must use a single Prisma transaction covering: DeliveryItem records, ContainerMovements, CustomerLedgerEntries, and DeliveryRun totals update. If any step throws, the entire transaction must roll back. A partial save corrupts the ledger, container counts, and rider cash simultaneously.

- ContainerMovement always requires productId — never nullable. A 19L Can movement and a 13L Can movement must never be combined or reconciled against each other. Container balance per customer = SUM(DELIVERED_TO_CUSTOMER) - SUM(RETURNED_FROM_CUSTOMER) always filtered by productId.

- sellingPriceSnapshot and unitCostSnapshot on DeliveryItem must be resolved and written at save time, never deferred. Resolve selling price from CustomerProductPrice for that productId; fall back to Product.defaultSellingPrice. Resolve unit cost from ProductCostHistory: latest record where productId = X AND effectiveFrom <= deliveryDate. If no cost history exists, throw a clear error rather than storing zero. Once saved, these snapshot fields must never be overwritten by future price or cost changes.

- Customer receivable balance must always be calculated as SUM of CustomerLedgerEntry.amount for that customer. Never store a manually editable balance field and use it as the source of truth. A cached balance field, if added for performance, must be kept in sync by the same transaction that writes the ledger entry — never updated in a separate call.

- Rider cash balance formula: SUM(Delivery.cashReceived where riderId) - SUM(Expense.amount where isPaidByRider=true AND staffId=riderId) - SUM(CashHandover.amount where riderId). Only confirmed/approved rider-paid expenses must be deducted, not all expenses.

- SaaS usage counter must only count DeliveryItem quantities where the parent Delivery status is DELIVERED. When a delivery is cancelled, decrement the counter by the same quantities in the same transaction. Never count FAILED or CANCELLED deliveries and never let a cancel-then-recreate flow double-count.

- RefillBatch records are per Product (flat) — one record per fill per product (19L Can fill is a separate record from 13L Can fill). Never create a single RefillBatch covering multiple products. ProductCostHistory and RefillBatch.costPerUnit are separate concerns: CostHistory sets the default cost used for future delivery snapshots; RefillBatch records the actual cost of a specific physical fill and does not automatically update CostHistory.

- TenantSettings must not store defaultCanSize, defaultSellingPrice, or defaultRefillCost. Product sizes, default selling prices, and cost history all live in the flat Product and ProductCostHistory models. Adding these fields to TenantSettings creates a second source of truth and causes pricing bugs when they diverge.

- There is NO ProductVariant model in this project. The product model is flat — 19L Can and 13L Can are separate Product records. If Cursor generates a ProductVariant model, stop and revert. Every FK that references a product must use productId pointing to the Product table directly.

- Served areas must live in a tenant-scoped Area table — never as Json on TenantSettings and never as a free-text area string on Customer. Customer.areaId is a FK to Area. On customer create/update, accept areaId OR areaName; if areaName is new, find-or-create the Area in the same Prisma transaction (trim + case-insensitive match within tenant). Settings Served Areas UI must read/write via /api/v1/areas so areas created during customer onboarding appear there automatically.
