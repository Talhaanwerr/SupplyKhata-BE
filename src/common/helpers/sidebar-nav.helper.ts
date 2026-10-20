import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Stable sidebar keys — must match FE `constants/tenant-nav.ts`. No seeded placements. */
export const SIDEBAR_NAV_KEYS = [
  'dashboard',
  'products',
  'customers',
  'vehicles',
  'deliveryRuns',
  'deliveries',
  'orders',
  'invoices',
  'inventory',
  'vendors',
  'rawMaterials',
  'purchaseOrders',
  'vendorBills',
  'vendorPayables',
  'recipes',
  'production',
  'refillBatches',
  'expenses',
  'cashHandovers',
  'containerInventory',
  'payments',
  'plannedStops',
  'collections',
  'riders',
  'users',
  'roles',
  'reports',
  'activityLogs',
] as const;

export type SidebarNavKey = (typeof SIDEBAR_NAV_KEYS)[number];

/** Nav key → feature flag (omit = always available). Keep in sync with FE tenant-nav. */
export const SIDEBAR_NAV_FEATURE_FLAGS: Partial<Record<SidebarNavKey, string>> = {
  orders: 'orders',
  invoices: 'invoices',
  inventory: 'inventory',
  vendors: 'vendors',
  rawMaterials: 'raw-materials',
  purchaseOrders: 'purchase-orders',
  vendorBills: 'vendor-bills',
  vendorPayables: 'vendor-bills',
  recipes: 'production',
  production: 'production',
  refillBatches: 'plant-fill',
  containerInventory: 'returnable-containers',
};

export type SidebarNavPrefs = {
  /** Keys shown under More / Setup. Anything else stays Primary. Empty = all primary. */
  more: SidebarNavKey[];
};

const KEY_SET = new Set<string>(SIDEBAR_NAV_KEYS);

type DbClient = Prisma.TransactionClient | PrismaService;

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

/** Sidebar keys whose feature flag is OFF for this tenant. */
export async function getFeatureDisabledSidebarKeys(
  db: DbClient,
  tenantId: string,
): Promise<Set<SidebarNavKey>> {
  const flagSlugs = [...new Set(Object.values(SIDEBAR_NAV_FEATURE_FLAGS))];
  if (flagSlugs.length === 0) return new Set();

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

  const disabled = new Set<SidebarNavKey>();
  for (const [key, flagSlug] of Object.entries(SIDEBAR_NAV_FEATURE_FLAGS) as Array<
    [SidebarNavKey, string]
  >) {
    if (!effectivelyEnabled(bySlug.get(flagSlug) ?? null)) {
      disabled.add(key);
    }
  }
  return disabled;
}

export function parseSidebarNav(raw: unknown, disabledKeys?: Set<string>): SidebarNavPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { more: [] };
  }
  const moreRaw = (raw as { more?: unknown }).more;
  if (!Array.isArray(moreRaw)) return { more: [] };

  const seen = new Set<string>();
  const more: SidebarNavKey[] = [];
  for (const item of moreRaw) {
    if (typeof item !== 'string' || !KEY_SET.has(item) || seen.has(item)) continue;
    if (disabledKeys?.has(item)) continue;
    seen.add(item);
    more.push(item as SidebarNavKey);
  }
  return { more };
}

export function normalizeSidebarNavInput(
  more: string[] | undefined,
  disabledKeys?: Set<string>,
): SidebarNavPrefs | undefined {
  if (more === undefined) return undefined;
  return parseSidebarNav({ more }, disabledKeys);
}
