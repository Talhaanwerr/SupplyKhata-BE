import {
  OrderPaymentStatus as PrismaOrderPaymentStatus,
  OrderStatus as PrismaOrderStatus,
  Prisma,
} from '@prisma/client';

type DecimalLike = Prisma.Decimal | number | null | undefined;

export function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** paymentStatus from amountPaid vs total. */
export function recomputePaymentStatus(
  amountPaid: number,
  total: number,
): PrismaOrderPaymentStatus {
  const paid = roundMoney(amountPaid);
  const tot = roundMoney(total);
  if (paid <= 0) return PrismaOrderPaymentStatus.UNPAID;
  if (paid + 0.00001 >= tot) return PrismaOrderPaymentStatus.PAID;
  return PrismaOrderPaymentStatus.PARTIALLY_PAID;
}

/**
 * After deliver updates: all lines fully delivered → DELIVERED;
 * any delivered > 0 → PARTIALLY_DELIVERED; else keep current (SHIPPED).
 */
export function recomputeFulfillmentAfterDeliver(
  items: Array<{ quantity: number; quantityDelivered: number }>,
  currentStatus: PrismaOrderStatus,
): PrismaOrderStatus {
  if (items.length === 0) return currentStatus;
  const allDone = items.every((i) => i.quantityDelivered + 0.00001 >= i.quantity);
  if (allDone) return PrismaOrderStatus.DELIVERED;
  const any = items.some((i) => i.quantityDelivered > 0);
  if (any) return PrismaOrderStatus.PARTIALLY_DELIVERED;
  return currentStatus;
}

export function computeOrderTotals(input: {
  lines: Array<{ quantity: number; unitPrice: number; lineDiscount?: number }>;
  discountTotal?: number;
  deliveryCharges?: number;
}): {
  subtotal: number;
  discountTotal: number;
  deliveryCharges: number;
  total: number;
  lineTotals: number[];
} {
  const lineTotals = input.lines.map((line) => {
    const raw = line.quantity * line.unitPrice - (line.lineDiscount ?? 0);
    return roundMoney(Math.max(0, raw));
  });
  const subtotal = roundMoney(lineTotals.reduce((s, n) => s + n, 0));
  const discountTotal = roundMoney(Math.max(0, input.discountTotal ?? 0));
  const deliveryCharges = roundMoney(Math.max(0, input.deliveryCharges ?? 0));
  const total = roundMoney(Math.max(0, subtotal - discountTotal + deliveryCharges));
  return { subtotal, discountTotal, deliveryCharges, total, lineTotals };
}
