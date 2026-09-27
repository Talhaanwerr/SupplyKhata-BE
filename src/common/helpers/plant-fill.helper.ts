import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const PLANT_FILL_FLAG_SLUG = 'plant-fill';

export const PLANT_FILL_DISABLED_MESSAGE = 'Plant Fill Log is disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Tenant feature flag for plant fill / refill batches.
 * effectivelyEnabled = tenant override ?? flag.isGlobal (same as FeatureFlagsService).
 */
export async function isPlantFillEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: PLANT_FILL_FLAG_SLUG },
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

/** Refill-batch APIs — hard fail when flag is off. */
export async function assertPlantFillEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isPlantFillEnabled(db, tenantId))) {
    throw new ForbiddenException(PLANT_FILL_DISABLED_MESSAGE);
  }
}

/** Delivery run create — reject refill loads when plant fill is off. */
export function assertNoRefillLoadsWhenPlantFillDisabled(
  enabled: boolean,
  refillLoads: unknown[] | undefined | null,
): void {
  if (enabled) return;
  if (refillLoads && refillLoads.length > 0) {
    throw new BadRequestException(PLANT_FILL_DISABLED_MESSAGE);
  }
}
