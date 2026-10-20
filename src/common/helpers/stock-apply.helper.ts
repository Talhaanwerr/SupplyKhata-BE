import { BadRequestException } from '@nestjs/common';
import { Prisma, RawMaterialMovementType, StockMovementType } from '@prisma/client';
import { lockRawMaterialBalance, lockStockBalance } from './stock-lock.helper';

type Tx = Prisma.TransactionClient;

/**
 * Shared product stock apply: lock balance → update qty → create StockMovement.
 * `quantity` is signed (+ IN / − OUT) for this location.
 */
export async function applyProductStockMovement(
  tx: Tx,
  args: {
    tenantId: string;
    locationId: string;
    productId: string;
    type: StockMovementType;
    quantity: Prisma.Decimal;
    actorId?: string | null;
    reason?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    transferGroupId?: string | null;
    insufficientMessage?: string;
  },
) {
  const balance = await lockStockBalance(tx, {
    tenantId: args.tenantId,
    locationId: args.locationId,
    productId: args.productId,
  });

  const current = new Prisma.Decimal(balance.quantity);
  const next = current.add(args.quantity);
  if (next.lessThan(0)) {
    throw new BadRequestException(
      args.insufficientMessage ?? 'Insufficient stock: resulting quantity would be negative',
    );
  }

  await tx.stockBalance.update({
    where: { id: balance.id },
    data: { quantity: next },
  });

  return tx.stockMovement.create({
    data: {
      tenantId: args.tenantId,
      locationId: args.locationId,
      productId: args.productId,
      type: args.type,
      quantity: args.quantity,
      reason: args.reason ?? null,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
      transferGroupId: args.transferGroupId ?? null,
      createdByUserId: args.actorId ?? null,
    },
  });
}

/**
 * Shared raw-material stock apply: lock balance → update qty → create RawMaterialMovement.
 */
export async function applyRawStockMovement(
  tx: Tx,
  args: {
    tenantId: string;
    locationId: string;
    rawMaterialId: string;
    type: RawMaterialMovementType;
    quantity: Prisma.Decimal;
    actorId?: string | null;
    reason?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    insufficientMessage?: string;
  },
) {
  const balance = await lockRawMaterialBalance(tx, {
    tenantId: args.tenantId,
    locationId: args.locationId,
    rawMaterialId: args.rawMaterialId,
  });

  const current = new Prisma.Decimal(balance.quantity);
  const next = current.add(args.quantity);
  if (next.lessThan(0)) {
    throw new BadRequestException(
      args.insufficientMessage ??
        'Insufficient raw material stock: resulting quantity would be negative',
    );
  }

  await tx.rawMaterialBalance.update({
    where: { id: balance.id },
    data: { quantity: next },
  });

  return tx.rawMaterialMovement.create({
    data: {
      tenantId: args.tenantId,
      locationId: args.locationId,
      rawMaterialId: args.rawMaterialId,
      type: args.type,
      quantity: args.quantity,
      reason: args.reason ?? null,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
      createdByUserId: args.actorId ?? null,
    },
  });
}
