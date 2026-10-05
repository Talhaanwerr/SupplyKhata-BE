import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_TENANT_TZ } from './calendar-utc.helper';

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Resolve tenant business timezone.
 * Prefers TenantSettings.timezone, then Tenant.timezone, then Asia/Karachi.
 */
export async function getTenantTimezone(db: DbClient, tenantId: string): Promise<string> {
  const [settings, tenant] = await Promise.all([
    db.tenantSettings.findUnique({
      where: { tenantId },
      select: { timezone: true },
    }),
    db.tenant.findFirst({
      where: { id: tenantId },
      select: { timezone: true },
    }),
  ]);
  const tz = settings?.timezone?.trim() || tenant?.timezone?.trim();
  return tz || DEFAULT_TENANT_TZ;
}
