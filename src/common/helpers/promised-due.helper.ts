import {
  DeliveryStatus as PrismaDeliveryStatus,
  LedgerEntryType as PrismaLedgerEntryType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Cash that counts toward settling a rider payment promise:
 * - standalone Payment rows (paymentDate)
 * - delivery cash ledger PAYMENT rows (delivery.deliveryDate), excluding cancelled
 */
async function paidTowardPromiseSince(
  db: DbClient,
  tenantId: string,
  customerId: string,
  dueDay: Date,
): Promise<number> {
  const [paymentAgg, deliveryCashEntries] = await Promise.all([
    db.payment.aggregate({
      where: {
        tenantId,
        customerId,
        paymentDate: { gte: dueDay },
      },
      _sum: { amount: true },
    }),
    db.customerLedgerEntry.findMany({
      where: {
        tenantId,
        customerId,
        entryType: PrismaLedgerEntryType.PAYMENT,
        referenceType: 'delivery',
        referenceId: { not: null },
      },
      select: { amount: true, referenceId: true },
    }),
  ]);

  let total = decimalToNumber(paymentAgg._sum.amount);

  const deliveryIds = [
    ...new Set(
      deliveryCashEntries
        .map((row) => row.referenceId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  if (deliveryIds.length === 0) return total;

  const qualifyingDeliveries = await db.delivery.findMany({
    where: {
      tenantId,
      customerId,
      id: { in: deliveryIds },
      deliveryDate: { gte: dueDay },
      status: { not: PrismaDeliveryStatus.CANCELLED },
    },
    select: { id: true },
  });
  const qualifying = new Set(qualifyingDeliveries.map((d) => d.id));

  for (const row of deliveryCashEntries) {
    if (!row.referenceId || !qualifying.has(row.referenceId)) continue;
    // Ledger PAYMENT amounts are stored negative (credit).
    total += Math.abs(decimalToNumber(row.amount));
  }

  return total;
}

/**
 * Clear rider payment promise when balance is settled OR payments on/after
 * the promised due date cover the promised amount (any payment if amount unset).
 * Counts standalone payments and cash collected on deliveries.
 */
export async function clearPromisedDueIfSettled(
  db: DbClient,
  tenantId: string,
  customerId: string,
): Promise<boolean> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId, deletedAt: null },
    select: {
      promisedDueDate: true,
      promisedDueAmount: true,
    },
  });
  if (!customer?.promisedDueDate) return false;

  const balanceAgg = await db.customerLedgerEntry.aggregate({
    where: { tenantId, customerId },
    _sum: { amount: true },
  });
  const balance = decimalToNumber(balanceAgg._sum.amount);
  if (balance <= 0.00001) {
    await db.customer.update({
      where: { id: customerId },
      data: {
        promisedDueDate: null,
        promisedDueAmount: null,
        promisedDueDeliveryId: null,
      },
    });
    return true;
  }

  const dueDay = startOfDay(customer.promisedDueDate);
  const paidSinceDue = await paidTowardPromiseSince(db, tenantId, customerId, dueDay);
  const promisedAmount =
    customer.promisedDueAmount == null ? null : decimalToNumber(customer.promisedDueAmount);

  const covered =
    promisedAmount == null ? paidSinceDue > 0.00001 : paidSinceDue + 0.00001 >= promisedAmount;

  if (!covered) return false;

  await db.customer.update({
    where: { id: customerId },
    data: {
      promisedDueDate: null,
      promisedDueAmount: null,
      promisedDueDeliveryId: null,
    },
  });
  return true;
}

export async function clearFulfilledPromisesForTenant(
  db: PrismaService,
  tenantId: string,
): Promise<void> {
  const withPromise = await db.customer.findMany({
    where: {
      tenantId,
      deletedAt: null,
      promisedDueDate: { not: null },
    },
    select: { id: true },
  });
  for (const customer of withPromise) {
    await clearPromisedDueIfSettled(db, tenantId, customer.id);
  }
}
