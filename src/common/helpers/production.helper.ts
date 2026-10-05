import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const PRODUCTION_FLAG_SLUG = 'production';
export const PRODUCTION_DISABLED_MESSAGE = 'Production is disabled for this workspace';

/**
 * BOM CRUD asserts `production` only.
 * Stock posts on production complete later also need inventory + raw-materials.
 */
type DbClient = Prisma.TransactionClient | PrismaService;

export async function isProductionEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: PRODUCTION_FLAG_SLUG },
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

export async function assertProductionEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isProductionEnabled(db, tenantId))) {
    throw new ForbiddenException(PRODUCTION_DISABLED_MESSAGE);
  }
}
