import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVendorsEnabled } from './vendors.helper';

export const VENDOR_BILLS_FLAG_SLUG = 'vendor-bills';
export const VENDOR_BILLS_DISABLED_MESSAGE = 'Vendor bills are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

export async function isVendorBillsEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: VENDOR_BILLS_FLAG_SLUG },
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

export async function assertVendorBillsEnabled(db: DbClient, tenantId: string): Promise<void> {
  await assertVendorsEnabled(db, tenantId);
  if (!(await isVendorBillsEnabled(db, tenantId))) {
    throw new ForbiddenException(VENDOR_BILLS_DISABLED_MESSAGE);
  }
}
