import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductBaseUnit } from '../enums/product.enum';

export const RETURNABLE_CONTAINERS_FLAG_SLUG = 'returnable-containers';

export const RETURNABLE_CONTAINERS_DISABLED_MESSAGE =
  'Returnable containers are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

export type PackagingProduct = {
  baseUnit: ProductBaseUnit | string;
  isReturnable: boolean;
  name?: string;
  containerCapacity?: Prisma.Decimal | number | null;
};

/**
 * True when sale qty is litres/kg but packaging (cans) is tracked separately.
 */
export function needsExplicitPackagingCount(product: {
  baseUnit: ProductBaseUnit | string;
  isReturnable: boolean;
}): boolean {
  if (!product.isReturnable) return false;
  const unit = product.baseUnit;
  return (
    unit === ProductBaseUnit.LTR || unit === 'LTR' || unit === ProductBaseUnit.KG || unit === 'KG'
  );
}

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

/**
 * Resolve filled packaging count for run stock rows.
 * PCS returnable: defaults to whole filledCount. LTR/KG returnable: requires explicit count when filled > 0.
 */
export function resolveFilledPackagingCount(
  product: PackagingProduct,
  filledCount: number,
  filledPackagingCount: number | null | undefined,
): number {
  if (!product.isReturnable || filledCount <= 0) return 0;

  if (needsExplicitPackagingCount(product)) {
    const cans = filledPackagingCount ?? 0;
    if (!Number.isInteger(cans) || cans < 1) {
      throw new BadRequestException(
        `Enter how many filled cans hold the ${filledCount} base units for "${product.name ?? 'product'}"`,
      );
    }
    return cans;
  }

  // PCS: packaging units = sale/stock units
  if (!Number.isInteger(filledCount)) {
    throw new BadRequestException(
      `Filled count for "${product.name ?? 'product'}" must be a whole number of cans`,
    );
  }
  return filledCount;
}

/**
 * How many packaging units leave with the customer for this delivery line.
 * PCS: quantityDelivered. LTR/KG returnable: requires containersDelivered.
 */
export function packagingUnitsOutForDelivery(
  product: PackagingProduct,
  quantityDelivered: number,
  containersDelivered?: number | null,
): number {
  if (!product.isReturnable || quantityDelivered <= 0) return 0;

  if (needsExplicitPackagingCount(product)) {
    const cans = containersDelivered ?? 0;
    if (!Number.isInteger(cans) || cans < 1) {
      throw new BadRequestException(
        `Enter containers given for "${product.name ?? 'product'}" (litres/kg sold is not the can count)`,
      );
    }
    return cans;
  }

  if (!Number.isInteger(quantityDelivered)) {
    throw new BadRequestException(
      'Container movements require whole packaging units for PCS products',
    );
  }
  return quantityDelivered;
}
