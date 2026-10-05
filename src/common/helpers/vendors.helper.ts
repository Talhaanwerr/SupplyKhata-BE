import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const VENDORS_FLAG_SLUG = 'vendors';
export const VENDORS_DISABLED_MESSAGE = 'Vendors are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

export async function isVendorsEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: VENDORS_FLAG_SLUG },
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

export async function assertVendorsEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isVendorsEnabled(db, tenantId))) {
    throw new ForbiddenException(VENDORS_DISABLED_MESSAGE);
  }
}
