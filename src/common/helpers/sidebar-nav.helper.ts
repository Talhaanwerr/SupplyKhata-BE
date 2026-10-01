/** Stable sidebar keys — must match FE `constants/tenant-nav.ts`. No seeded placements. */
export const SIDEBAR_NAV_KEYS = [
  'dashboard',
  'products',
  'customers',
  'vehicles',
  'deliveryRuns',
  'orders',
  'invoices',
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

export type SidebarNavPrefs = {
  /** Keys shown under More / Setup. Anything else stays Primary. Empty = all primary. */
  more: SidebarNavKey[];
};

const KEY_SET = new Set<string>(SIDEBAR_NAV_KEYS);

export function parseSidebarNav(raw: unknown): SidebarNavPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { more: [] };
  }
  const moreRaw = (raw as { more?: unknown }).more;
  if (!Array.isArray(moreRaw)) return { more: [] };

  const seen = new Set<string>();
  const more: SidebarNavKey[] = [];
  for (const item of moreRaw) {
    if (typeof item !== 'string' || !KEY_SET.has(item) || seen.has(item)) continue;
    seen.add(item);
    more.push(item as SidebarNavKey);
  }
  return { more };
}

export function normalizeSidebarNavInput(more: string[] | undefined): SidebarNavPrefs | undefined {
  if (more === undefined) return undefined;
  return parseSidebarNav({ more });
}
