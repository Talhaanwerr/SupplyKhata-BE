import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertPurchaseOrdersEnabled } from '../common/helpers/purchase-orders.helper';
import {
  CancelPurchaseOrderDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  PurchaseOrderLineInputDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';

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

function endOfDay(value: string): Date {
  const d = parseCalendarDateUtc(value, true);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return d;
}

const lineInclude = {
  product: { select: { id: true, name: true, sku: true, baseUnit: true } },
  rawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
} as const;

/**
 * Purchase order master (draft / send / cancel). Stock IN happens on GRN only.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListPurchaseOrdersQueryDto) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const { skip, take } = getPaginationParams({ page, limit });

    const where: Prisma.PurchaseOrderWhereInput = {
      tenantId,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search?.trim() ? { poNumber: { contains: query.search.trim() } } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: parseDate(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          vendor: { select: { id: true, name: true, phone: true, isActive: true } },
          _count: { select: { lines: true } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        ...this.mapHeader(r),
        vendor: r.vendor,
        lineCount: r._count.lines,
      })),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    const po = await this.requirePo(tenantId, id, true);
    return this.mapDetail(po);
  }

  async create(tenantId: string, dto: CreatePurchaseOrderDto, actorId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    await this.assertActiveVendor(tenantId, dto.vendorId);
    const normalized = await this.normalizeLines(tenantId, dto.lines);

    const po = await this.prisma.$transaction(async (tx) => {
      const poNumber = await this.nextPoNumber(tx, tenantId);
      const created = await tx.purchaseOrder.create({
        data: {
          tenantId,
          vendorId: dto.vendorId,
          status: PurchaseOrderStatus.DRAFT,
          poNumber,
          expectedDate: dto.expectedDate ? parseDate(dto.expectedDate) : null,
          notes: dto.notes?.trim() || null,
          createdByUserId: actorId,
          lines: {
            create: normalized.map((l, idx) => ({
              tenantId,
              lineNo: idx + 1,
              rawMaterialId: l.rawMaterialId,
              productId: l.productId,
              qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
              unitCost: new Prisma.Decimal(l.unitCost),
              qtyReceived: new Prisma.Decimal(0),
            })),
          },
        },
        include: {
          vendor: { select: { id: true, name: true, phone: true, isActive: true } },
          lines: { include: lineInclude, orderBy: { lineNo: 'asc' } },
        },
      });
      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'purchase-orders',
      action: 'CREATE',
      entityId: po.id,
      newValue: { poNumber: po.poNumber, vendorId: po.vendorId, status: po.status },
    });

    return this.mapDetail(po);
  }

  async update(id: string, tenantId: string, dto: UpdatePurchaseOrderDto, actorId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    const existing = await this.requirePo(tenantId, id, true);
    if (existing.status !== PurchaseOrderStatus.DRAFT) {
      throw new BadRequestException('Only draft purchase orders can be edited');
    }

    if (dto.vendorId) {
      await this.assertActiveVendor(tenantId, dto.vendorId);
    }

    const normalized = dto.lines ? await this.normalizeLines(tenantId, dto.lines) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (normalized) {
        await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id, tenantId } });
        await tx.purchaseOrderLine.createMany({
          data: normalized.map((l, idx) => ({
            tenantId,
            purchaseOrderId: id,
            lineNo: idx + 1,
            rawMaterialId: l.rawMaterialId,
            productId: l.productId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitCost: new Prisma.Decimal(l.unitCost),
            qtyReceived: new Prisma.Decimal(0),
          })),
        });
      }

      return tx.purchaseOrder.update({
        where: { id },
        data: {
          ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
          ...(dto.expectedDate !== undefined
            ? { expectedDate: dto.expectedDate ? parseDate(dto.expectedDate) : null }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        },
        include: {
          vendor: { select: { id: true, name: true, phone: true, isActive: true } },
          lines: { include: lineInclude, orderBy: { lineNo: 'asc' } },
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'purchase-orders',
      action: 'UPDATE',
      entityId: id,
      newValue: { poNumber: updated.poNumber, vendorId: updated.vendorId },
    });

    return this.mapDetail(updated);
  }

  async send(id: string, tenantId: string, actorId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    const po = await this.requirePo(tenantId, id, true);
    if (po.status !== PurchaseOrderStatus.DRAFT) {
      throw new BadRequestException('Only draft purchase orders can be sent');
    }
    if (!po.lines.length) {
      throw new BadRequestException('Cannot send a purchase order with zero lines');
    }
    await this.assertActiveVendor(tenantId, po.vendorId);

    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.SENT },
      include: {
        vendor: { select: { id: true, name: true, phone: true, isActive: true } },
        lines: { include: lineInclude, orderBy: { lineNo: 'asc' } },
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'purchase-orders',
      action: 'SEND',
      entityId: id,
      oldValue: { status: po.status },
      newValue: { status: updated.status },
    });

    return this.mapDetail(updated);
  }

  async cancel(id: string, tenantId: string, dto: CancelPurchaseOrderDto, actorId: string) {
    await assertPurchaseOrdersEnabled(this.prisma, tenantId);
    const po = await this.requirePo(tenantId, id, true);
    if (po.status === PurchaseOrderStatus.RECEIVED || po.status === PurchaseOrderStatus.CANCELLED) {
      throw new BadRequestException('This purchase order cannot be cancelled');
    }
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new BadRequestException('Cancel reason is required');
    }

    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        status: PurchaseOrderStatus.CANCELLED,
        cancelReason: reason,
      },
      include: {
        vendor: { select: { id: true, name: true, phone: true, isActive: true } },
        lines: { include: lineInclude, orderBy: { lineNo: 'asc' } },
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'purchase-orders',
      action: 'CANCEL',
      entityId: id,
      oldValue: { status: po.status },
      newValue: { status: updated.status, cancelReason: reason },
    });

    return this.mapDetail(updated);
  }

  private async nextPoNumber(tx: Prisma.TransactionClient, tenantId: string) {
    const count = await tx.purchaseOrder.count({ where: { tenantId } });
    return `PO-${String(count + 1).padStart(5, '0')}`;
  }

  private async assertActiveVendor(tenantId: string, vendorId: string) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: vendorId, tenantId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (!vendor.isActive) {
      throw new BadRequestException('Vendor is inactive');
    }
  }

  private async normalizeLines(tenantId: string, lines: PurchaseOrderLineInputDto[]) {
    if (!lines.length) {
      throw new BadRequestException('At least one line is required');
    }

    const normalized = lines.map((l) => {
      const rawId = l.rawMaterialId?.trim() || null;
      const productId = l.productId?.trim() || null;
      if ((!rawId && !productId) || (rawId && productId)) {
        throw new BadRequestException(
          'Each line must have exactly one of rawMaterialId or productId',
        );
      }
      if (l.qtyOrdered <= 0) {
        throw new BadRequestException('qtyOrdered must be greater than 0');
      }
      if (l.unitCost < 0) {
        throw new BadRequestException('unitCost cannot be negative');
      }
      return {
        rawMaterialId: rawId,
        productId,
        qtyOrdered: l.qtyOrdered,
        unitCost: l.unitCost,
      };
    });

    const productIds = normalized.map((l) => l.productId).filter((id): id is string => !!id);
    const rawIds = normalized.map((l) => l.rawMaterialId).filter((id): id is string => !!id);

    if (productIds.length) {
      const count = await this.prisma.product.count({
        where: { tenantId, id: { in: productIds }, deletedAt: null },
      });
      if (count !== new Set(productIds).size) {
        throw new BadRequestException('One or more products were not found');
      }
    }
    if (rawIds.length) {
      const count = await this.prisma.rawMaterial.count({
        where: { tenantId, id: { in: rawIds } },
      });
      if (count !== new Set(rawIds).size) {
        throw new BadRequestException('One or more raw materials were not found');
      }
    }

    return normalized;
  }

  private async requirePo(tenantId: string, id: string, _withLines = true) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
      include: {
        vendor: { select: { id: true, name: true, phone: true, isActive: true } },
        lines: { include: lineInclude, orderBy: { lineNo: 'asc' } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  private mapHeader(r: {
    id: string;
    tenantId: string;
    vendorId: string;
    status: PurchaseOrderStatus;
    poNumber: string | null;
    expectedDate: Date | null;
    notes: string | null;
    cancelReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      tenantId: r.tenantId,
      vendorId: r.vendorId,
      status: r.status,
      poNumber: r.poNumber,
      expectedDate: r.expectedDate,
      notes: r.notes,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private mapDetail(po: {
    id: string;
    tenantId: string;
    vendorId: string;
    status: PurchaseOrderStatus;
    poNumber: string | null;
    expectedDate: Date | null;
    notes: string | null;
    cancelReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    vendor: { id: string; name: string; phone: string | null; isActive: boolean };
    lines: Array<{
      id: string;
      lineNo: number;
      rawMaterialId: string | null;
      productId: string | null;
      qtyOrdered: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      qtyReceived: Prisma.Decimal;
      product: { id: string; name: string; sku: string | null; baseUnit: string } | null;
      rawMaterial: {
        id: string;
        name: string;
        sku: string | null;
        unit: string;
      } | null;
    }>;
  }) {
    return {
      ...this.mapHeader(po),
      vendor: po.vendor,
      lines: po.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        rawMaterialId: l.rawMaterialId,
        productId: l.productId,
        qtyOrdered: decimalToNumber(l.qtyOrdered),
        unitCost: decimalToNumber(l.unitCost),
        qtyReceived: decimalToNumber(l.qtyReceived),
        remaining: decimalToNumber(l.qtyOrdered) - decimalToNumber(l.qtyReceived),
        product: l.product,
        rawMaterial: l.rawMaterial,
      })),
    };
  }
}
