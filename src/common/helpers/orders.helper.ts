import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const ORDERS_FLAG_SLUG = 'orders';

export const ORDERS_DISABLED_MESSAGE = 'Orders are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Tenant feature flag for customer Orders channel.
 * effectivelyEnabled = tenant override ?? flag.isGlobal (same as FeatureFlagsService).
 */
export async function isOrdersEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: ORDERS_FLAG_SLUG },
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

export async function assertOrdersEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isOrdersEnabled(db, tenantId))) {
    throw new ForbiddenException(ORDERS_DISABLED_MESSAGE);
  }
}
