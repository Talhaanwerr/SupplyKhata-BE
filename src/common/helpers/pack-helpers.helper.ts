import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const PACK_HELPERS_FLAG_SLUG = 'pack-helpers';

export const PACK_HELPERS_DISABLED_MESSAGE =
  'Pack helpers (carton/crate) are disabled for this workspace';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Tenant feature flag for pack label / units-per-pack delivery helpers.
 * effectivelyEnabled = tenant override ?? flag.isGlobal (same as FeatureFlagsService).
 */
export async function isPackHelpersEnabled(db: DbClient, tenantId: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({
    where: { slug: PACK_HELPERS_FLAG_SLUG },
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

/** Product create/update — reject pack fields when flag is off. */
export function assertNoPackFieldsWhenDisabled(
  enabled: boolean,
  fields: { unitsPerPack?: number | null; packLabel?: string | null },
): void {
  if (enabled) return;
  const hasUnits = fields.unitsPerPack != null;
  const hasLabel = fields.packLabel != null && String(fields.packLabel).trim() !== '';
  if (hasUnits || hasLabel) {
    throw new BadRequestException(PACK_HELPERS_DISABLED_MESSAGE);
  }
}
