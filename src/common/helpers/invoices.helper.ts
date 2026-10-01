import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const INVOICES_FLAG_SLUG = 'invoices';

export const INVOICES_DISABLED_MESSAGE = 'Invoices are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Tenant feature flag for customer Invoices (period statements).
 * effectivelyEnabled = tenant override ?? flag.isGlobal (same as FeatureFlagsService).
 */
export async function isInvoicesEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: INVOICES_FLAG_SLUG },
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

export async function assertInvoicesEnabled(db: DbClient, tenantId: string): Promise<void> {
  if (!(await isInvoicesEnabled(db, tenantId))) {
    throw new ForbiddenException(INVOICES_DISABLED_MESSAGE);
  }
}
