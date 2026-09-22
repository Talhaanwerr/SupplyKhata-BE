# SaaS Boilerplate — NestJS Backend

Production-ready multi-tenant SaaS backend built with NestJS, Prisma, MySQL, and TypeScript.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 10 + Express |
| Language | TypeScript (strict) |
| ORM | Prisma 5 (MySQL) |
| Auth | JWT (access + refresh) + Argon2 |
| RBAC | Custom roles + granular permissions |
| Mail | Nodemailer + Handlebars templates |
| File Storage | Local (dev) · S3-compatible (prod) |
| Logging | Winston (structured JSON) |
| Rate Limiting | @nestjs/throttler |
| Security | Helmet, CORS, input validation, account lockout |
| Testing | Jest (unit) · Supertest (e2e) |
| CI | GitHub Actions |
| Containerization | Docker + Docker Compose |

---

## Quick Start (Local)

### 1. Prerequisites

- Node.js 20+
- MySQL 8.0 (or Docker)
- npm

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, MAIL_* values
```

### 4. Database setup

```bash
# Run migrations
npm run prisma:migrate

# Seed default roles & permissions
npm run prisma:seed
```

### 5. Start development server

```bash
npm run start:dev
```

API runs at: `http://localhost:4700/api/v1`  
Swagger docs: `http://localhost:4700/api/docs`

---

## Docker (Recommended for Production)

### Full stack (API + MySQL + Redis)

```bash
# Copy and fill env
cp .env.example .env

# Build and start
docker compose up --build -d

# Run migrations inside the container
docker compose exec api npx prisma migrate deploy

# Seed initial data
docker compose exec api npx ts-node prisma/seed.ts
```

### Individual services

```bash
# Start only MySQL and Redis
docker compose up mysql redis -d

# Build API image only
docker build -t saas-api .

# Run API container
docker run --env-file .env -p 3000:3000 saas-api
```

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run start:prod` | Run production build |
| `npm run lint` | Lint & auto-fix |
| `npm run lint:check` | Lint without fixing (CI) |
| `npm run type-check` | TypeScript type check |
| `npm run test` | Run unit tests |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | Run e2e tests |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run prisma:migrate` | Run migrations (dev) |
| `npm run prisma:migrate:prod` | Run migrations (production) |
| `npm run prisma:seed` | Seed roles & permissions |
| `npm run prisma:studio` | Open Prisma Studio |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | MySQL connection string |
| `JWT_SECRET` | ✅ | — | Access token secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | ✅ | — | Refresh token secret (min 32 chars) |
| `JWT_EXPIRES_IN` | | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | | `7d` | Refresh token lifetime |
| `FRONTEND_URL` | | `http://localhost:3001` | Used in email links |
| `CORS_ORIGINS` | | `http://localhost:3001` | Comma-separated allowed origins |
| `MAIL_HOST` | | `smtp.mailtrap.io` | SMTP host |
| `MAIL_PORT` | | `2525` | SMTP port |
| `MAIL_USER` | | — | SMTP username |
| `MAIL_PASS` | | — | SMTP password |
| `STORAGE_DRIVER` | | `local` | `local` or `s3` |
| `UPLOAD_DIR` | | `./uploads` | Local upload path |
| `S3_BUCKET` | | — | S3 bucket name |
| `S3_REGION` | | — | S3 region |
| `S3_ACCESS_KEY_ID` | | — | S3 access key |
| `S3_SECRET_ACCESS_KEY` | | — | S3 secret |
| `S3_ENDPOINT` | | — | S3 endpoint (for MinIO etc.) |
| `LOGIN_MAX_ATTEMPTS` | | `5` | Max failed logins before lockout |
| `LOGIN_LOCKOUT_MINUTES` | | `15` | Lockout window duration |
| `SWAGGER_ENABLED` | | `true` | Disable in production |

---

## API Modules

| Module | Prefix | Description |
|---|---|---|
| Auth | `/api/v1/auth` | Login, logout, refresh, forgot/reset password, verify email |
| Tenants | `/api/v1/tenants` | Tenant CRUD (super admin only) |
| Users | `/api/v1/users` | Invite, create, list, update, deactivate users (tenant-scoped) |
| Roles | `/api/v1/roles` | Role & permission management |
| Settings | `/api/v1/settings` | Tenant settings |
| Feature Flags | `/api/v1/feature-flags` | Global & tenant feature flags |
| Files | `/api/v1/files` | Secure file upload & management |
| Notifications | `/api/v1/notifications` | In-app notifications |
| Audit Logs | `/api/v1/audit-logs` | Audit trail (tenant-scoped) |
| Health | `/api/v1/health` | Liveness/readiness probe |

---

## Architecture Overview

```
src/
├── auth/              # JWT auth, guards, strategies, decorators
├── common/
│   ├── decorators/    # @CurrentUser, @CurrentTenant, @Roles, @RequirePermissions, @Public
│   ├── filters/       # Global HTTP exception filter (no stack leaks)
│   ├── guards/        # RolesGuard, PermissionsGuard, TenantGuard, SuperAdminGuard
│   ├── interceptors/  # ResponseInterceptor (consistent envelope)
│   └── types/         # ApiResponse, PaginatedResponse
├── config/            # Env validation (Joi)
├── prisma/            # PrismaService
├── mail/              # MailService + Handlebars templates
├── audit-logs/        # AuditLogsService (reusable, used by all modules)
├── tenants/           # Tenant management
├── users/             # User management (tenant-scoped)
├── roles/             # RBAC roles & permissions
├── settings/          # Tenant settings
├── feature-flags/     # Feature flag management
├── files/             # File upload (local/S3 abstraction)
└── notifications/     # In-app notifications
```

### Tenant Isolation

- All user-facing queries filter by `tenantId` from the JWT
- `TenantGuard` enforces `req.tenantId` — no unscoped queries reach services
- Super admins can scope to any tenant via `X-Tenant-ID` header
- Cross-tenant access returns `403 Forbidden`, not `404`

### RBAC

- Default roles: `SUPER_ADMIN`, `TENANT_OWNER`, `TENANT_ADMIN`, `MANAGER`, `EMPLOYEE`, `VIEWER`
- Permissions use `module:action` format (e.g., `users:create`, `roles:read`)
- `@RequirePermissions('users:create')` on any controller method enforces permission check

---

## Testing

```bash
# Unit tests
npm run test

# Unit tests with coverage
npm run test:cov

# E2E tests
npm run test:e2e
```

Unit tests cover:
- `AuthService` — login, refresh, lockout, logout
- `TenantGuard` — isolation, super admin override
- `PermissionsGuard` — allow/deny logic
- `UsersService` — create, findOne, deactivate, cross-tenant denial
- `TenantsService` — create, findOne, status changes

---

## Production Deployment

```bash
# 1. Build image
docker build -t saas-api:latest .

# 2. Run migrations
docker run --env-file .env saas-api:latest npx prisma migrate deploy

# 3. Start container
docker run -d --env-file .env -p 3000:3000 saas-api:latest

# Health check endpoint
curl http://localhost:3000/api/v1/health
```

---

## Security Highlights

- **Helmet** — secure HTTP headers (CSP, HSTS, etc.)
- **Strict CORS** — only configured origins
- **Argon2** — password hashing (resistant to brute-force)
- **Account lockout** — configurable via `LOGIN_MAX_ATTEMPTS`
- **Refresh token rotation** — token theft detection (deletes all sessions on mismatch)
- **Input validation** — class-validator on all DTOs, forbids extra properties, `@MaxLength` on all password/token fields
- **No stack traces in production** — HTTP exception filter strips internal details
- **URL masking in logs** — sensitive query params (token, password, key) are masked
- **Swagger disabled in production** — unless explicitly enabled
- **Tenant isolation** — every DB query scoped to `tenantId`
- **Password complexity** — uppercase + lowercase + digit + special char required
- **File upload protection** — MIME allowlist (no SVG/executables), size limit from env, tenant-scoped paths
- **1 MB JSON body cap** — prevents large-payload DoS on JSON endpoints
- **httpOnly refresh cookie** — SameSite=Strict, path-scoped to `/api/v1/auth`

---

## Security Checklist (Before Going Live)

- [ ] Generate strong secrets: `openssl rand -hex 64` for `JWT_SECRET` and `JWT_REFRESH_SECRET`
- [ ] Set `SWAGGER_ENABLED=false` in production `.env`
- [ ] Set `NODE_ENV=production`
- [ ] Set `LOG_LEVEL=warn` or `error` in production
- [ ] Set `CORS_ORIGINS` to only your frontend domain(s)
- [ ] Set `FRONTEND_URL` to your production frontend URL (used in email links)
- [ ] Use S3 or equivalent for file storage (`STORAGE_DRIVER=s3`), not local disk
- [ ] Confirm MySQL is not exposed on a public port (use Docker internal network or firewall rule)
- [ ] Enable TLS/SSL on MySQL connection string in production
- [ ] Set up a firewall — only expose ports 80/443 publicly; keep 3000/3306/6379 internal
- [ ] Configure Let's Encrypt / Cloudflare for HTTPS on your domain
- [ ] Review and tighten rate limiting values (`THROTTLE_TTL`, `THROTTLE_LIMIT`) per endpoint requirements
- [ ] Rotate all secrets if any were committed to git history

---

## Database Backup Notes

### Automated MySQL dump (cron)

```bash
# Run daily at 2 AM, keep 7 days of backups
0 2 * * * mysqldump -u saas_user -p'PASSWORD' saas_db | gzip > /backups/saas_db_$(date +\%F).sql.gz
find /backups -name "*.sql.gz" -mtime +7 -delete
```

### Backup with Docker

```bash
docker compose exec mysql \
  mysqldump -u saas_user -pPASSWORD saas_db | gzip > backup_$(date +%F).sql.gz
```

### Restore from backup

```bash
gunzip -c backup_2026-01-01.sql.gz | \
  docker compose exec -T mysql mysql -u saas_user -pPASSWORD saas_db
```

### Notes

- Store backups off-server (S3, Backblaze B2, or similar)
- Test restores regularly — a backup you've never restored is an assumption, not a plan
- For zero-downtime backups at scale, use `mysqldump --single-transaction` or Percona XtraBackup

---

## Monitoring Notes

### Health endpoint

```
GET /api/v1/health
```

Returns `200 OK` with database and system status. Wire this into your uptime monitor (UptimeRobot, Better Uptime, Grafana Cloud, etc.).

### Recommended free monitoring stack for VPS

| Tool | Purpose | How |
|------|---------|-----|
| UptimeRobot | HTTP uptime monitoring | Add `/api/v1/health` as a monitor |
| Grafana + Loki | Log aggregation | Ship Winston logs to Loki via Promtail |
| Grafana + Prometheus | Metrics (CPU, memory, request rates) | Add `@nestjs/prometheus` module |
| Sentry | Error tracking | Add `@sentry/nestjs` and set `SENTRY_DSN` |

### Log locations (Docker)

```bash
# View live logs
docker compose logs -f api

# Last 100 lines
docker compose logs --tail=100 api
```

### Log format

Winston outputs structured JSON in production. Each log entry includes:
- `level` — error / warn / info
- `message` — sanitised message (no secrets, stack traces, or SQL)
- `timestamp` — ISO 8601
- `context` — service or class name

---

## Deployment Notes (VPS)

### Full deployment flow

```bash
# 1. Pull latest code on server
git pull origin main

# 2. Build new image
docker build -t saas-api:latest .

# 3. Run DB migrations (zero-downtime — migrate deploy is safe to run on live DB)
docker run --rm --env-file .env saas-api:latest npx prisma migrate deploy

# 4. Swap container (no downtime if behind a load balancer / Nginx)
docker compose down api
docker compose up -d api
```

### Seeding (first deploy only)

Seeds are for initial setup and should be run from your **local machine** pointing to the production database:

```bash
# Set DATABASE_URL in your local .env to the production DB
DATABASE_URL="mysql://user:pass@prod-host:3306/saas_db" npm run prisma:seed
```

> Do not run `ts-node` inside the production Docker container — it is not available (devDependencies are excluded from the production image).

### Zero-downtime deployments

For zero downtime behind Nginx:
1. Start a second container on a different port
2. Update Nginx upstream to new container
3. Stop old container

Or use Docker Swarm / Kubernetes for proper rolling updates at scale.
