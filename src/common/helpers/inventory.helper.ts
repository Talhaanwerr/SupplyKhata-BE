import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const INVENTORY_FLAG_SLUG = 'inventory';
export const WAREHOUSE_FLAG_SLUG = 'warehouse';

export const INVENTORY_DISABLED_MESSAGE = 'Inventory is disabled for this workspace';
export const WAREHOUSE_DISABLED_MESSAGE =
  'Multi-location warehouse is disabled for this workspace. Enable the Warehouse flag to manage locations and transfers.';

type DbClient = Prisma.TransactionClient | PrismaService;

async function isFlagEnabled(db: DbClient, tenantId: string, slug: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug },
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

/** Finished-goods inventory (opening / adjust / on-hand). */
export async function isInventoryEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  return isFlagEnabled(db, tenantId, INVENTORY_FLAG_SLUG);
}

export async function assertInventoryEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isInventoryEnabled(db, tenantId))) {
    throw new ForbiddenException(INVENTORY_DISABLED_MESSAGE);
  }
}

/** Multi-location + transfers. Requires inventory to be useful. */
export async function isWarehouseEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  return isFlagEnabled(db, tenantId, WAREHOUSE_FLAG_SLUG);
}

export async function assertWarehouseEnabled(db: DbClient, tenantId: string): Promise<void> {
  await assertInventoryEnabled(db, tenantId);
  if (!(await isWarehouseEnabled(db, tenantId))) {
    throw new ForbiddenException(WAREHOUSE_DISABLED_MESSAGE);
  }
}
