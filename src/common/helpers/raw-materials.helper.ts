import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const RAW_MATERIALS_FLAG_SLUG = 'raw-materials';
export const RAW_MATERIALS_DISABLED_MESSAGE = 'Raw materials are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

export async function isRawMaterialsEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: RAW_MATERIALS_FLAG_SLUG },
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

export async function assertRawMaterialsEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isRawMaterialsEnabled(db, tenantId))) {
    throw new ForbiddenException(RAW_MATERIALS_DISABLED_MESSAGE);
  }
}
