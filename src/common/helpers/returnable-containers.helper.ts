import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const RETURNABLE_CONTAINERS_FLAG_SLUG = 'returnable-containers';

export const RETURNABLE_CONTAINERS_DISABLED_MESSAGE =
  'Returnable containers are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Tenant feature flag for empties / container inventory.
 * effectivelyEnabled = tenant override ?? flag.isGlobal (same as FeatureFlagsService).
 */
export async function isReturnableContainersEnabled(
  db: DbClient,
  tenantId: string,
): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: RETURNABLE_CONTAINERS_FLAG_SLUG },
    include: {
      tenantFeatures: {
        where: { tenantId },
        select: { isEnabled: true },
      },
    },
  });

  if (!flag || !flag.isActive) return false;

  const override = flag.tenantFeatures[0]?.isEnabled ?? null;
  return override !== null ? override : flag.isGlobal;
}

/** Mutating container APIs — hard fail when flag is off. */
export async function assertReturnableContainersEnabled(
  db: DbClient,
  tenantId: string,
): Promise<void> {
  if (!(await isReturnableContainersEnabled(db, tenantId))) {
    throw new ForbiddenException(RETURNABLE_CONTAINERS_DISABLED_MESSAGE);
  }
}

/** Delivery create — reject empties when flag off. */
export function assertNoEmptiesWhenContainersDisabled(
  enabled: boolean,
  items: Array<{ emptiesReceived?: number | null }>,
): void {
  if (enabled) return;
  if (items.some((item) => (item.emptiesReceived ?? 0) > 0)) {
    throw new BadRequestException(RETURNABLE_CONTAINERS_DISABLED_MESSAGE);
  }
}
