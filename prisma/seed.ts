import { PrismaClient, BillingCycle } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// ─── Super admin login (platform only — no demo tenants) ─────
const SUPER_ADMIN = {
  email: 'admin@saas.local',
  password: 'Admin@12345',
  firstName: 'Super',
  lastName: 'Admin',
};

// ─── Constants ────────────────────────────────────────────────

/** Platform + tenant system roles. Display names: Owner, Admin, Manager, Rider. */
const SYSTEM_ROLES = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    description: 'Platform owner with full access to everything',
    isSystem: true,
  },
  {
    slug: 'tenant_owner',
    name: 'Owner',
    description: 'Workspace owner with full tenant-level access',
    isSystem: true,
  },
  {
    slug: 'tenant_admin',
    name: 'Admin',
    description: 'Workspace administrator',
    isSystem: true,
  },
  {
    slug: 'manager',
    name: 'Manager',
    description: 'Manager with limited admin capabilities',
    isSystem: true,
  },
  {
    slug: 'rider',
    name: 'Rider',
    description: 'Delivery rider / loader — field operations access',
    isSystem: true,
  },
];

/** Removed from product — cleaned up on every seed run. */
const OBSOLETE_ROLE_SLUGS = ['employee', 'viewer'] as const;

const PERMISSION_MODULES = [
  'users',
  'tenants',
  'roles',
  'permissions',
  'subscriptions',
  'settings',
  'files',
  'notifications',
  'audit-logs',
  'feature-flags',
  'areas',
  'products',
  'customers',
  'vehicles',
  'deliveryruns',
  'deliveries',
  'payments',
  'ledger',
  'refill',
  'expenses',
  'handovers',
  'containers',
  'reports',
  'collections',
];

const PERMISSION_ACTIONS = ['create', 'read', 'update', 'delete', 'manage'];

const STARTER_PLANS = [
  {
    name: 'Free',
    slug: 'free',
    description: 'Get started at no cost',
    price: 0,
    currency: 'USD',
    billingCycle: BillingCycle.MONTHLY,
    isActive: true,
    maxUsers: 3,
    maxStorage: 512,
    trialDays: 0,
    features: {
      auditLogs: false,
      featureFlags: false,
      fileUpload: true,
      notifications: true,
    },
  },
  {
    name: 'Pro',
    slug: 'pro',
    description: 'For growing teams',
    price: 29,
    currency: 'USD',
    billingCycle: BillingCycle.MONTHLY,
    isActive: true,
    maxUsers: 25,
    maxStorage: 10240,
    trialDays: 14,
    features: {
      auditLogs: true,
      featureFlags: true,
      fileUpload: true,
      notifications: true,
    },
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'For large organizations with advanced needs',
    price: 99,
    currency: 'USD',
    billingCycle: BillingCycle.MONTHLY,
    isActive: true,
    maxUsers: 0,
    maxStorage: 0,
    trialDays: 30,
    features: {
      auditLogs: true,
      featureFlags: true,
      fileUpload: true,
      notifications: true,
      customDomain: true,
      sso: true,
    },
  },
];

/** Product feature flags — seeded as features ship; SA enables/disables per tenant. */
const STARTER_FEATURE_FLAGS = [
  {
    name: 'Advanced Reports',
    slug: 'advanced-reports',
    description: 'Exportable analytics and custom report builder',
    isGlobal: false,
    isActive: true,
  },
  {
    name: 'File Uploads',
    slug: 'file-uploads',
    description: 'Allow workspace file storage and uploads',
    isGlobal: false,
    isActive: true,
  },
  {
    name: 'Audit Log Export',
    slug: 'audit-log-export',
    description: 'CSV/JSON export of audit history',
    isGlobal: false,
    isActive: true,
  },
  {
    name: 'Custom Branding',
    slug: 'custom-branding',
    description: 'Logo and theme color customization',
    isGlobal: false,
    isActive: true,
  },
  {
    name: 'Returnable Containers',
    slug: 'returnable-containers',
    description:
      'Track returnable packaging (empties, customer container balances, owned inventory). Disable for tenants that only sell non-returnable goods (e.g. rice).',
    // Global default ON so water tenants keep current behaviour; SA disables per rice-only tenant.
    isGlobal: true,
    isActive: true,
  },
];

// ─── Helpers ──────────────────────────────────────────────────

function buildPermissions(): { module: string; action: string; description: string }[] {
  const permissions: { module: string; action: string; description: string }[] = [];

  for (const module of PERMISSION_MODULES) {
    for (const action of PERMISSION_ACTIONS) {
      permissions.push({
        module,
        action,
        description: `Can ${action} ${module}`,
      });
    }
  }

  return permissions;
}

/** Replace a role's permissions with exactly the given keys (adds missing, removes extras). */
async function syncRolePermissions(
  roleId: string,
  allowedKeys: Set<string>,
  permissions: Record<string, { id: string }>,
): Promise<void> {
  const allowedIds = [...allowedKeys]
    .map((key) => permissions[key]?.id)
    .filter((id): id is string => !!id);

  await prisma.rolePermission.deleteMany({
    where: {
      roleId,
      ...(allowedIds.length > 0 ? { permissionId: { notIn: allowedIds } } : {}),
    },
  });

  for (const key of allowedKeys) {
    const perm = permissions[key];
    if (!perm) continue;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId: perm.id } },
      update: {},
      create: { roleId, permissionId: perm.id },
    });
  }
}

// ─── Seed ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Seeding database...');

  // 1. Seed system roles (tenantId = null means platform-level)
  // MySQL unique compounds cannot use null in upsert where — use findFirst instead
  console.log('  → Seeding system roles...');
  const roles: Record<string, { id: string }> = {};

  for (const role of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { tenantId: null, slug: role.slug },
    });

    const created = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: role.name, description: role.description },
        })
      : await prisma.role.create({
          data: {
            tenantId: null,
            name: role.name,
            slug: role.slug,
            description: role.description,
            isSystem: role.isSystem,
          },
        });

    roles[role.slug] = created;
  }

  // 1b. Remove obsolete system roles (Employee, Viewer, etc.)
  console.log('  → Removing obsolete roles...');
  for (const slug of OBSOLETE_ROLE_SLUGS) {
    const obsolete = await prisma.role.findMany({ where: { slug } });
    for (const role of obsolete) {
      await prisma.role.delete({ where: { id: role.id } });
      console.log(`     removed role slug=${slug} id=${role.id}`);
    }
  }

  // 2. Upsert all permissions
  console.log('  → Seeding permissions...');
  const permissionDefs = buildPermissions();
  const permissions: Record<string, { id: string }> = {};

  for (const perm of permissionDefs) {
    const created = await prisma.permission.upsert({
      where: { module_action: { module: perm.module, action: perm.action } },
      update: { description: perm.description },
      create: perm,
    });
    permissions[`${perm.module}:${perm.action}`] = created;
  }

  // 3. Assign ALL permissions to SUPER_ADMIN
  console.log('  → Assigning all permissions to super_admin...');
  await syncRolePermissions(
    roles['super_admin'].id,
    new Set(Object.keys(permissions)),
    permissions,
  );

  // 4. Owner — full tenant access minus platform-only actions
  console.log('  → Assigning permissions to Owner (tenant_owner)...');
  const tenantOwnerExcluded = new Set([
    'tenants:create',
    'tenants:delete',
    'tenants:manage',
    'feature-flags:create',
    'feature-flags:delete',
    'feature-flags:manage',
    'permissions:create',
    'permissions:delete',
    'permissions:manage',
  ]);
  await syncRolePermissions(
    roles['tenant_owner'].id,
    new Set(Object.keys(permissions).filter((key) => !tenantOwnerExcluded.has(key))),
    permissions,
  );

  // 5. Admin
  console.log('  → Assigning permissions to Admin (tenant_admin)...');
  await syncRolePermissions(
    roles['tenant_admin'].id,
    new Set([
      'users:create',
      'users:read',
      'users:update',
      'users:delete',
      'roles:read',
      'permissions:read',
      'files:create',
      'files:read',
      'files:update',
      'files:delete',
      'notifications:read',
      'notifications:update',
      'audit-logs:read',
      'settings:read',
      'settings:update',
      'areas:create',
      'areas:read',
      'areas:update',
      'areas:delete',
      'products:create',
      'products:read',
      'products:update',
      'products:delete',
      'customers:create',
      'customers:read',
      'customers:update',
      'customers:delete',
      'vehicles:create',
      'vehicles:read',
      'vehicles:update',
      'vehicles:delete',
      'deliveryruns:create',
      'deliveryruns:read',
      'deliveryruns:update',
      'deliveries:create',
      'deliveries:read',
      'deliveries:update',
      'payments:create',
      'payments:read',
      'payments:update',
      'payments:delete',
      'ledger:read',
      'refill:create',
      'refill:read',
      'refill:update',
      'refill:delete',
      'expenses:create',
      'expenses:read',
      'expenses:update',
      'expenses:delete',
      'handovers:create',
      'handovers:read',
      'handovers:update',
      'handovers:delete',
      'containers:create',
      'containers:read',
      'containers:update',
      'containers:delete',
      'reports:read',
      'collections:create',
      'collections:read',
      'collections:update',
      'collections:delete',
    ]),
    permissions,
  );

  // 5b. Manager
  console.log('  → Assigning permissions to Manager...');
  await syncRolePermissions(
    roles['manager'].id,
    new Set([
      'users:read',
      'files:read',
      'notifications:read',
      'notifications:update',
      'settings:read',
      'areas:read',
      'products:create',
      'products:read',
      'products:update',
      'products:delete',
      'customers:create',
      'customers:read',
      'customers:update',
      'customers:delete',
      'vehicles:create',
      'vehicles:read',
      'vehicles:update',
      'vehicles:delete',
      'deliveryruns:create',
      'deliveryruns:read',
      'deliveryruns:update',
      'deliveries:create',
      'deliveries:read',
      'deliveries:update',
      'payments:create',
      'payments:read',
      'payments:update',
      'payments:delete',
      'ledger:read',
      'refill:create',
      'refill:read',
      'refill:update',
      'refill:delete',
      'expenses:create',
      'expenses:read',
      'expenses:update',
      'expenses:delete',
      'handovers:create',
      'handovers:read',
      'handovers:update',
      'handovers:delete',
      'containers:create',
      'containers:read',
      'containers:update',
      'containers:delete',
      'reports:read',
      'collections:create',
      'collections:read',
      'collections:update',
    ]),
    permissions,
  );

  // 5c. Rider — field ops + vehicles read + collect payments on route
  console.log('  → Assigning permissions to Rider...');
  await syncRolePermissions(
    roles['rider'].id,
    new Set([
      'customers:read',
      'areas:read',
      'products:read',
      'files:read',
      'notifications:read',
      'notifications:update',
      'vehicles:read',
      'deliveryruns:read',
      'deliveries:create',
      'deliveries:read',
      'payments:create',
      'payments:read',
      'ledger:read',
      'expenses:create',
      'handovers:read',
      'containers:read',
      'collections:create',
      'collections:read',
    ]),
    permissions,
  );

  // 7. Upsert starter plans
  console.log('  → Seeding plans...');
  for (const plan of STARTER_PLANS) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        price: plan.price,
        maxUsers: plan.maxUsers,
        maxStorage: plan.maxStorage,
        features: plan.features,
      },
      create: plan,
    });
  }

  // 7b. Upsert product feature flags (catalog — not created via SA UI)
  console.log('  → Seeding feature flags...');
  for (const flag of STARTER_FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { slug: flag.slug },
      update: {
        name: flag.name,
        description: flag.description,
        isGlobal: flag.isGlobal,
        isActive: flag.isActive,
      },
      create: flag,
    });
  }

  // 8. Super admin login account
  console.log('  → Seeding super admin...');
  const superAdminPasswordHash = await argon2.hash(SUPER_ADMIN.password);
  await prisma.user.upsert({
    where: { email: SUPER_ADMIN.email },
    update: {
      firstName: SUPER_ADMIN.firstName,
      lastName: SUPER_ADMIN.lastName,
      passwordHash: superAdminPasswordHash,
      isSuperAdmin: true,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      deletedAt: null,
    },
    create: {
      email: SUPER_ADMIN.email,
      firstName: SUPER_ADMIN.firstName,
      lastName: SUPER_ADMIN.lastName,
      passwordHash: superAdminPasswordHash,
      isSuperAdmin: true,
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.log('✅ Seeding complete.');
  console.log(
    `   Roles     : ${Object.keys(roles).length} (Owner, Admin, Manager, Rider + Super Admin)`,
  );
  console.log(`   Permissions: ${Object.keys(permissions).length}`);
  console.log(`   Plans     : ${STARTER_PLANS.length}`);
  console.log(`   Feature flags: ${STARTER_FEATURE_FLAGS.length}`);
  console.log('');
  console.log('── Login ────────────────────────────────────────');
  console.log(`   Super Admin : ${SUPER_ADMIN.email} / ${SUPER_ADMIN.password}`);
  console.log('   Create tenants from Super Admin UI.');
  console.log('─────────────────────────────────────────────────');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
