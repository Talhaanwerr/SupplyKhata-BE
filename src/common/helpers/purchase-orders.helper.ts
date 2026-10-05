import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVendorsEnabled } from './vendors.helper';

export const PURCHASE_ORDERS_FLAG_SLUG = 'purchase-orders';
export const PURCHASE_ORDERS_DISABLED_MESSAGE = 'Purchase orders are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

export async function isPurchaseOrdersEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: PURCHASE_ORDERS_FLAG_SLUG },
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

/** PO/GRN require purchase-orders flag and vendors flag. */
export async function assertPurchaseOrdersEnabled(db: DbClient, tenantId: string): Promise<void> {
  await assertVendorsEnabled(db, tenantId);
  if (!(await isPurchaseOrdersEnabled(db, tenantId))) {
    throw new ForbiddenException(PURCHASE_ORDERS_DISABLED_MESSAGE);
  }
}
