import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PurchaseOrderStatus,
  RawMaterialMovementType,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InventoryService } from '../inventory/inventory.service';
import { VendorBillsService } from '../vendor-bills/vendor-bills.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertPurchaseOrdersEnabled } from '../common/helpers/purchase-orders.helper';
import { assertInventoryEnabled } from '../common/helpers/inventory.helper';
import { assertRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';
import { isVendorBillsEnabled } from '../common/helpers/vendor-bills.helper';
import { lockPurchaseOrderLine } from '../common/helpers/stock-lock.helper';
import {
  applyProductStockMovement,
  applyRawStockMovement,
} from '../common/helpers/stock-apply.helper';
import { CreateGoodsReceiptDto, ListGoodsReceiptsQueryDto } from './dto/goods-receipt.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function parseDate(value: string): Date {
  const parsed = parseCalendarDateUtc(value, false);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return parsed;
}

/**
 * Goods receipt → stock IN (product PURCHASE_IN / raw PURCHASE_IN).
 * Over-receive blocked. Never touches DeliveryRunStock.
 */
@Injectable()
export class GoodsReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inventory: InventoryService,
    private readonly vendorBills: VendorBillsService,
  ) {}

  async list(tenantId: string, query: ListGoodsReceiptsQueryDto) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.GoodsReceiptWhereInput = {
      tenantId,
      ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          location: { select: { id: true, name: true } },
          receivedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          purchaseOrder: { select: { id: true, poNumber: true, status: true } },
          _count: { select: { lines: true } },
        },
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        purchaseOrderId: r.purchaseOrderId,
        locationId: r.locationId,
        receiptDate: r.receiptDate,
        notes: r.notes,
        createdAt: r.createdAt,
        location: r.location,
        receivedBy: r.receivedBy,
        purchaseOrder: r.purchaseOrder,
        lineCount: r._count.lines,
      })),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    const receipt = await this.prisma.goodsReceipt.findFirst({
      where: { id, tenantId },
      include: {
        location: { select: { id: true, name: true, type: true } },
        receivedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
        lines: {
          include: {
            purchaseOrderLine: {
              include: {
                product: { select: { id: true, name: true, sku: true } },
                rawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
              },
            },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException('Goods receipt not found');

    return {
      id: receipt.id,
      purchaseOrderId: receipt.purchaseOrderId,
      locationId: receipt.locationId,
      receiptDate: receipt.receiptDate,
      notes: receipt.notes,
      createdAt: receipt.createdAt,
      location: receipt.location,
      receivedBy: receipt.receivedBy,
      purchaseOrder: receipt.purchaseOrder,
      lines: receipt.lines.map((l) => ({
        id: l.id,
        purchaseOrderLineId: l.purchaseOrderLineId,
        qtyReceived: decimalToNumber(l.qtyReceived),
        purchaseOrderLine: {
          id: l.purchaseOrderLine.id,
          lineNo: l.purchaseOrderLine.lineNo,
          unitCost: decimalToNumber(l.purchaseOrderLine.unitCost),
          product: l.purchaseOrderLine.product,
          rawMaterial: l.purchaseOrderLine.rawMaterial,
        },
      })),
    };
  }

  async createForPo(
    purchaseOrderId: string,
    tenantId: string,
    dto: CreateGoodsReceiptDto,
    actorId: string,
  ) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);

    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, tenantId },
      include: {
        lines: {
          include: {
            product: { select: { id: true, name: true } },
            rawMaterial: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    if (
      po.status !== PurchaseOrderStatus.SENT &&
      po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new BadRequestException(
        'Goods receipt is only allowed for SENT or PARTIALLY_RECEIVED purchase orders',
      );
    }

    const location = await this.resolveLocation(tenantId, dto.locationId);
    const lineById = new Map(po.lines.map((l) => [l.id, l]));

    // Collapse duplicate PO line IDs in one request into a single qty.
    const qtyByLineId = new Map<string, Prisma.Decimal>();
    for (const input of dto.lines) {
      if (input.qtyReceived <= 0) {
        throw new BadRequestException('qtyReceived must be greater than 0');
      }
      if (!lineById.has(input.purchaseOrderLineId)) {
        throw new BadRequestException(`Unknown purchase order line: ${input.purchaseOrderLineId}`);
      }
      const prev = qtyByLineId.get(input.purchaseOrderLineId) ?? new Prisma.Decimal(0);
      qtyByLineId.set(input.purchaseOrderLineId, prev.add(input.qtyReceived));
    }

    const receiveLines = [...qtyByLineId.entries()].map(([purchaseOrderLineId, qty]) => ({
      purchaseOrderLineId,
      qtyReceived: qty,
    }));

    let needsInventory = false;
    let needsRaw = false;
    for (const input of receiveLines) {
      const poLine = lineById.get(input.purchaseOrderLineId)!;
      const remaining = new Prisma.Decimal(poLine.qtyOrdered).sub(poLine.qtyReceived);
      if (input.qtyReceived.greaterThan(remaining)) {
        const name = poLine.product?.name || poLine.rawMaterial?.name || `line #${poLine.lineNo}`;
        throw new BadRequestException(
          `Cannot receive ${input.qtyReceived.toString()} of "${name}" — only ${remaining.toString()} remaining on this PO`,
        );
      }
      if (poLine.productId) needsInventory = true;
      if (poLine.rawMaterialId) needsRaw = true;
    }

    if (needsInventory) await assertInventoryEnabled(this.prisma, tenantId);
    if (needsRaw) await assertRawMaterialsEnabled(this.prisma, tenantId);

    const autoBill = await isVendorBillsEnabled(this.prisma, tenantId);

    const { receiptId, vendorBill } = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.goodsReceipt.create({
          data: {
            tenantId,
            purchaseOrderId,
            locationId: location.id,
            receiptDate: parseDate(dto.receiptDate),
            notes: dto.notes?.trim() || null,
            receivedByUserId: actorId,
            lines: {
              create: receiveLines.map((l) => ({
                tenantId,
                purchaseOrderLineId: l.purchaseOrderLineId,
                qtyReceived: l.qtyReceived,
              })),
            },
          },
          include: { lines: true },
        });

        const billLines: Array<{
          id: string;
          purchaseOrderLineId: string;
          qtyReceived: Prisma.Decimal;
          unitCost: Prisma.Decimal;
          description: string;
        }> = [];

        for (const input of receiveLines) {
          const locked = await lockPurchaseOrderLine(tx, {
            tenantId,
            lineId: input.purchaseOrderLineId,
          });
          if (!locked) {
            throw new BadRequestException(
              `Unknown purchase order line: ${input.purchaseOrderLineId}`,
            );
          }

          const remaining = new Prisma.Decimal(locked.qtyOrdered).sub(locked.qtyReceived);
          if (input.qtyReceived.greaterThan(remaining)) {
            const meta = lineById.get(input.purchaseOrderLineId);
            const name = meta?.product?.name || meta?.rawMaterial?.name || `line #${locked.lineNo}`;
            throw new BadRequestException(
              `Cannot receive ${input.qtyReceived.toString()} of "${name}" — only ${remaining.toString()} remaining on this PO`,
            );
          }

          await tx.purchaseOrderLine.update({
            where: { id: locked.id },
            data: {
              qtyReceived: new Prisma.Decimal(locked.qtyReceived).add(input.qtyReceived),
            },
          });

          if (locked.productId) {
            await this.applyProductPurchaseIn(tx, {
              tenantId,
              locationId: location.id,
              productId: locked.productId,
              quantity: input.qtyReceived,
              actorId,
              referenceId: created.id,
            });
          } else if (locked.rawMaterialId) {
            await this.applyRawPurchaseIn(tx, {
              tenantId,
              locationId: location.id,
              rawMaterialId: locked.rawMaterialId,
              quantity: input.qtyReceived,
              actorId,
              referenceId: created.id,
            });
          }

          const meta = lineById.get(input.purchaseOrderLineId)!;
          const grLine = created.lines.find(
            (l) => l.purchaseOrderLineId === input.purchaseOrderLineId,
          );
          if (grLine) {
            billLines.push({
              id: grLine.id,
              purchaseOrderLineId: input.purchaseOrderLineId,
              qtyReceived: input.qtyReceived,
              unitCost: meta.unitCost,
              description:
                meta.product?.name || meta.rawMaterial?.name || `PO line #${meta.lineNo}`,
            });
          }
        }

        const freshLines = await tx.purchaseOrderLine.findMany({
          where: { purchaseOrderId, tenantId },
        });
        const allReceived = freshLines.every((l) =>
          new Prisma.Decimal(l.qtyReceived).greaterThanOrEqualTo(l.qtyOrdered),
        );
        const anyReceived = freshLines.some((l) =>
          new Prisma.Decimal(l.qtyReceived).greaterThan(0),
        );

        const nextStatus = allReceived
          ? PurchaseOrderStatus.RECEIVED
          : anyReceived
            ? PurchaseOrderStatus.PARTIALLY_RECEIVED
            : po.status;

        await tx.purchaseOrder.update({
          where: { id: purchaseOrderId },
          data: { status: nextStatus },
        });

        let vendorBillResult: {
          id: string;
          billNumber: string | null;
          totalAmount: number;
          remaining: number;
        } | null = null;

        if (autoBill) {
          vendorBillResult = await this.vendorBills.createBillForReceiptInTx(tx, {
            tenantId,
            actorId,
            goodsReceiptId: created.id,
            purchaseOrderId,
            vendorId: po.vendorId,
            poNumber: po.poNumber,
            receiptDate: created.receiptDate,
            dueDate: dto.billDueDate || dto.receiptDate,
            lines: billLines,
          });
        }

        return { receiptId: created.id, vendorBill: vendorBillResult };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    await this.audit.write({
      tenantId,
      actorId,
      module: 'grn',
      action: 'RECEIVE',
      entityId: receiptId,
      newValue: {
        purchaseOrderId,
        locationId: location.id,
        lines: receiveLines.map((l) => ({
          purchaseOrderLineId: l.purchaseOrderLineId,
          qtyReceived: decimalToNumber(l.qtyReceived),
        })),
        vendorBillId: vendorBill?.id ?? null,
      },
    });

    if (vendorBill) {
      await this.audit.write({
        tenantId,
        actorId,
        module: 'vendor-bills',
        action: 'CREATE',
        entityId: vendorBill.id,
        newValue: {
          billNumber: vendorBill.billNumber,
          goodsReceiptId: receiptId,
          totalAmount: vendorBill.totalAmount,
        },
      });
    }

    const detail = await this.findOne(receiptId, tenantId);
    return { ...detail, vendorBill, vendorBillError: null as string | null };
  }

  private async resolveLocation(tenantId: string, locationId?: string) {
    const defaultLoc = await this.inventory.ensureDefaultLocation(tenantId);
    if (!locationId) return defaultLoc;
    const loc = await this.prisma.stockLocation.findFirst({
      where: { id: locationId, tenantId, isActive: true },
      select: { id: true, name: true },
    });
    if (!loc) throw new NotFoundException('Stock location not found');
    return loc;
  }

  private async applyProductPurchaseIn(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      productId: string;
      quantity: Prisma.Decimal;
      actorId: string;
      referenceId: string;
    },
  ) {
    await applyProductStockMovement(tx, {
      tenantId: args.tenantId,
      locationId: args.locationId,
      productId: args.productId,
      type: StockMovementType.PURCHASE_IN,
      quantity: args.quantity,
      referenceType: 'GoodsReceipt',
      referenceId: args.referenceId,
      actorId: args.actorId,
    });
  }

  private async applyRawPurchaseIn(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      rawMaterialId: string;
      quantity: Prisma.Decimal;
      actorId: string;
      referenceId: string;
    },
  ) {
    await applyRawStockMovement(tx, {
      tenantId: args.tenantId,
      locationId: args.locationId,
      rawMaterialId: args.rawMaterialId,
      type: RawMaterialMovementType.PURCHASE_IN,
      quantity: args.quantity,
      referenceType: 'GoodsReceipt',
      referenceId: args.referenceId,
      actorId: args.actorId,
    });
  }
}
