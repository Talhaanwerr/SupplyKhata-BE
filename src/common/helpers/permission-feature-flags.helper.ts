import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Permission `module` → tenant feature-flag slug.
 * Modules not listed here are always available (core delivery / admin).
 * Keep in sync with FE nav / FEATURE_FLAG_SLUGS usage.
 */
export const PERMISSION_MODULE_FEATURE_FLAG: Record<string, string> = {
  containers: 'returnable-containers',
  orders: 'orders',
  pos: 'pos',
  invoices: 'invoices',
  inventory: 'inventory',
  vendors: 'vendors',
  'raw-materials': 'raw-materials',
  'purchase-orders': 'purchase-orders',
  grn: 'purchase-orders',
  'vendor-bills': 'vendor-bills',
  production: 'production',
  bom: 'production',
  refill: 'plant-fill',
};

function effectivelyEnabled(
  flag: {
    isActive: boolean;
    isGlobal: boolean;
    tenantFeatures: Array<{ isEnabled: boolean }>;
  } | null,
): boolean {
  if (!flag || !flag.isActive) return false;
  const override = flag.tenantFeatures[0]?.isEnabled ?? null;
  return override !== null ? override : flag.isGlobal;
}

/**
 * Permission modules that should be hidden from tenant role UI / assign catalog
 * because their feature flag is OFF for this workspace.
 */
export async function getFeatureDisabledPermissionModules(
  db: DbClient,
  tenantId: string,
): Promise<Set<string>> {
  const flagSlugs = [...new Set(Object.values(PERMISSION_MODULE_FEATURE_FLAG))];
  const flags = await db.featureFlag.findMany({
    where: { slug: { in: flagSlugs } },
    select: {
      slug: true,
      isActive: true,
      isGlobal: true,
      tenantFeatures: {
        where: { tenantId },
        select: { isEnabled: true },
      },
    },
  });
  const bySlug = new Map(flags.map((f) => [f.slug, f]));

  const disabled = new Set<string>();
  for (const [module, flagSlug] of Object.entries(PERMISSION_MODULE_FEATURE_FLAG)) {
    if (!effectivelyEnabled(bySlug.get(flagSlug) ?? null)) {
      disabled.add(module);
    }
  }
  return disabled;
}
