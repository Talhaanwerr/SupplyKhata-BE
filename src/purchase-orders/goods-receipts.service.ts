import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PurchaseOrderStatus,
  RawMaterialMovementType,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InventoryService } from '../inventory/inventory.service';
import { VendorBillsService } from '../vendor-bills/vendor-bills.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertPurchaseOrdersEnabled } from '../common/helpers/purchase-orders.helper';
import { assertInventoryEnabled } from '../common/helpers/inventory.helper';
import { assertRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';
import { isVendorBillsEnabled } from '../common/helpers/vendor-bills.helper';
import { CreateGoodsReceiptDto, ListGoodsReceiptsQueryDto } from './dto/goods-receipt.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
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

    // Pre-validate line types for flag asserts
    let needsInventory = false;
    let needsRaw = false;
    for (const input of dto.lines) {
      const poLine = lineById.get(input.purchaseOrderLineId);
      if (!poLine) {
        throw new BadRequestException(`Unknown purchase order line: ${input.purchaseOrderLineId}`);
      }
      if (input.qtyReceived <= 0) {
        throw new BadRequestException('qtyReceived must be greater than 0');
      }
      const ordered = new Prisma.Decimal(poLine.qtyOrdered);
      const already = new Prisma.Decimal(poLine.qtyReceived);
      const remaining = ordered.sub(already);
      const qty = new Prisma.Decimal(input.qtyReceived);
      if (qty.greaterThan(remaining)) {
        const name = poLine.product?.name || poLine.rawMaterial?.name || `line #${poLine.lineNo}`;
        throw new BadRequestException(
          `Cannot receive ${input.qtyReceived} of "${name}" — only ${remaining.toString()} remaining on this PO`,
        );
      }
      if (poLine.productId) needsInventory = true;
      if (poLine.rawMaterialId) needsRaw = true;
    }

    if (needsInventory) await assertInventoryEnabled(this.prisma, tenantId);
    if (needsRaw) await assertRawMaterialsEnabled(this.prisma, tenantId);

    const receipt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.goodsReceipt.create({
        data: {
          tenantId,
          purchaseOrderId,
          locationId: location.id,
          receiptDate: parseDate(dto.receiptDate),
          notes: dto.notes?.trim() || null,
          receivedByUserId: actorId,
          lines: {
            create: dto.lines.map((l) => ({
              tenantId,
              purchaseOrderLineId: l.purchaseOrderLineId,
              qtyReceived: new Prisma.Decimal(l.qtyReceived),
            })),
          },
        },
        include: { lines: true },
      });

      for (const input of dto.lines) {
        const poLine = lineById.get(input.purchaseOrderLineId)!;
        const qty = new Prisma.Decimal(input.qtyReceived);

        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qtyReceived: new Prisma.Decimal(poLine.qtyReceived).add(qty) },
        });

        if (poLine.productId) {
          await this.applyProductPurchaseIn(tx, {
            tenantId,
            locationId: location.id,
            productId: poLine.productId,
            quantity: qty,
            actorId,
            referenceId: created.id,
          });
        } else if (poLine.rawMaterialId) {
          await this.applyRawPurchaseIn(tx, {
            tenantId,
            locationId: location.id,
            rawMaterialId: poLine.rawMaterialId,
            quantity: qty,
            actorId,
            referenceId: created.id,
          });
        }
      }

      // Refresh lines for status
      const freshLines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId, tenantId },
      });
      const allReceived = freshLines.every((l) =>
        new Prisma.Decimal(l.qtyReceived).greaterThanOrEqualTo(l.qtyOrdered),
      );
      const anyReceived = freshLines.some((l) => new Prisma.Decimal(l.qtyReceived).greaterThan(0));

      const nextStatus = allReceived
        ? PurchaseOrderStatus.RECEIVED
        : anyReceived
          ? PurchaseOrderStatus.PARTIALLY_RECEIVED
          : po.status;

      await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { status: nextStatus },
      });

      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'grn',
      action: 'RECEIVE',
      entityId: receipt.id,
      newValue: {
        purchaseOrderId,
        locationId: location.id,
        lines: dto.lines,
      },
    });

    const detail = await this.findOne(receipt.id, tenantId);

    // Auto-create payable bill when vendor-bills flag is on (qty × PO unit cost).
    let vendorBill: {
      id: string;
      billNumber: string | null;
      totalAmount: number;
      remaining: number;
    } | null = null;
    let vendorBillError: string | null = null;
    if (await isVendorBillsEnabled(this.prisma, tenantId)) {
      try {
        const bill = await this.vendorBills.createFromGoodsReceipt(tenantId, receipt.id, actorId, {
          dueDate: dto.billDueDate || dto.receiptDate,
        });
        vendorBill = {
          id: bill.id,
          billNumber: bill.billNumber,
          totalAmount: bill.totalAmount,
          remaining: bill.remaining,
        };
      } catch (err) {
        vendorBillError = err instanceof Error ? err.message : 'Could not create vendor bill';
      }
    }

    return { ...detail, vendorBill, vendorBillError };
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
    const balance = await tx.stockBalance.findUnique({
      where: {
        tenantId_locationId_productId: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          productId: args.productId,
        },
      },
    });
    const current = balance ? new Prisma.Decimal(balance.quantity) : new Prisma.Decimal(0);
    const next = current.add(args.quantity);

    if (balance) {
      await tx.stockBalance.update({
        where: { id: balance.id },
        data: { quantity: next },
      });
    } else {
      await tx.stockBalance.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          productId: args.productId,
          quantity: next,
        },
      });
    }

    await tx.stockMovement.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: args.productId,
        type: StockMovementType.PURCHASE_IN,
        quantity: args.quantity,
        referenceType: 'GoodsReceipt',
        referenceId: args.referenceId,
        createdByUserId: args.actorId,
      },
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
    const balance = await tx.rawMaterialBalance.findUnique({
      where: {
        tenantId_locationId_rawMaterialId: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          rawMaterialId: args.rawMaterialId,
        },
      },
    });
    const current = balance ? new Prisma.Decimal(balance.quantity) : new Prisma.Decimal(0);
    const next = current.add(args.quantity);

    if (balance) {
      await tx.rawMaterialBalance.update({
        where: { id: balance.id },
        data: { quantity: next },
      });
    } else {
      await tx.rawMaterialBalance.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          rawMaterialId: args.rawMaterialId,
          quantity: next,
        },
      });
    }

    await tx.rawMaterialMovement.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        rawMaterialId: args.rawMaterialId,
        type: RawMaterialMovementType.PURCHASE_IN,
        quantity: args.quantity,
        referenceType: 'GoodsReceipt',
        referenceId: args.referenceId,
        createdByUserId: args.actorId,
      },
    });
  }
}
