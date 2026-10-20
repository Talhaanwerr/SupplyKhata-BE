import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Lock stock / raw balance rows (MySQL FOR UPDATE) inside an interactive transaction.
 * Creates a zero-qty row when missing so concurrent writers serialize on the same row.
 */

export async function lockStockBalance(
  tx: Tx,
  args: { tenantId: string; locationId: string; productId: string },
): Promise<{ id: string; quantity: Prisma.Decimal }> {
  const existing = await tx.$queryRaw<Array<{ id: string; quantity: Prisma.Decimal }>>`
    SELECT id, quantity FROM stock_balances
    WHERE tenantId = ${args.tenantId}
      AND locationId = ${args.locationId}
      AND productId = ${args.productId}
    FOR UPDATE
  `;
  if (existing[0]) return existing[0];

  try {
    await tx.stockBalance.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: args.productId,
        quantity: 0,
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      throw err;
    }
  }

  const locked = await tx.$queryRaw<Array<{ id: string; quantity: Prisma.Decimal }>>`
    SELECT id, quantity FROM stock_balances
    WHERE tenantId = ${args.tenantId}
      AND locationId = ${args.locationId}
      AND productId = ${args.productId}
    FOR UPDATE
  `;
  if (!locked[0]) {
    throw new Error('Failed to lock stock balance row');
  }
  return locked[0];
}

export async function lockRawMaterialBalance(
  tx: Tx,
  args: { tenantId: string; locationId: string; rawMaterialId: string },
): Promise<{ id: string; quantity: Prisma.Decimal }> {
  const existing = await tx.$queryRaw<Array<{ id: string; quantity: Prisma.Decimal }>>`
    SELECT id, quantity FROM raw_material_balances
    WHERE tenantId = ${args.tenantId}
      AND locationId = ${args.locationId}
      AND rawMaterialId = ${args.rawMaterialId}
    FOR UPDATE
  `;
  if (existing[0]) return existing[0];

  try {
    await tx.rawMaterialBalance.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        rawMaterialId: args.rawMaterialId,
        quantity: 0,
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      throw err;
    }
  }

  const locked = await tx.$queryRaw<Array<{ id: string; quantity: Prisma.Decimal }>>`
    SELECT id, quantity FROM raw_material_balances
    WHERE tenantId = ${args.tenantId}
      AND locationId = ${args.locationId}
      AND rawMaterialId = ${args.rawMaterialId}
    FOR UPDATE
  `;
  if (!locked[0]) {
    throw new Error('Failed to lock raw material balance row');
  }
  return locked[0];
}

export async function lockPurchaseOrderLine(
  tx: Tx,
  args: { tenantId: string; lineId: string },
): Promise<{
  id: string;
  qtyOrdered: Prisma.Decimal;
  qtyReceived: Prisma.Decimal;
  productId: string | null;
  rawMaterialId: string | null;
  lineNo: number;
} | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      qtyOrdered: Prisma.Decimal;
      qtyReceived: Prisma.Decimal;
      productId: string | null;
      rawMaterialId: string | null;
      lineNo: number;
    }>
  >`
    SELECT id, qtyOrdered, qtyReceived, productId, rawMaterialId, lineNo
    FROM purchase_order_lines
    WHERE id = ${args.lineId} AND tenantId = ${args.tenantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function lockVendorBill(
  tx: Tx,
  args: { tenantId: string; billId: string },
): Promise<{
  id: string;
  vendorId: string;
  status: string;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
} | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      vendorId: string;
      status: string;
      totalAmount: Prisma.Decimal;
      paidAmount: Prisma.Decimal;
    }>
  >`
    SELECT id, vendorId, status, totalAmount, paidAmount
    FROM vendor_bills
    WHERE id = ${args.billId} AND tenantId = ${args.tenantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}
