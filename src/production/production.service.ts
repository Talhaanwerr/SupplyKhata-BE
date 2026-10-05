import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ProductionOrderStatus,
  RawMaterialMovementType,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InventoryService } from '../inventory/inventory.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertProductionEnabled } from '../common/helpers/production.helper';
import { assertInventoryEnabled } from '../common/helpers/inventory.helper';
import { assertRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';
import {
  CancelProductionOrderDto,
  CompleteProductionOrderDto,
  CreateProductionOrderDto,
  ListProductionOrdersQueryDto,
  UpdateProductionOrderDto,
} from './dto/production-order.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number | null {
  if (value == null) return null;
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

/**
 * Production orders. Stock only on complete. Never touches DeliveryRunStock / SALE_OUT.
 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inventory: InventoryService,
  ) {}

  async list(tenantId: string, query: ListProductionOrdersQueryDto) {
    await assertProductionEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.ProductionOrderWhereInput = {
      tenantId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.status ? { status: query.status } : {}),
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
      this.prisma.productionOrder.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: this.listInclude(),
      }),
      this.prisma.productionOrder.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.mapOrder(r)),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const order = await this.requireOrder(tenantId, id);
    return this.mapOrder(order);
  }

  async create(tenantId: string, dto: CreateProductionOrderDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    await this.requireProduct(tenantId, dto.productId);
    const bom = await this.resolveBom(tenantId, dto.productId, dto.bomId);
    const location = await this.resolveLocation(tenantId, dto.locationId);

    const order = await this.prisma.productionOrder.create({
      data: {
        tenantId,
        productId: dto.productId,
        bomId: bom.id,
        locationId: location.id,
        plannedQty: new Prisma.Decimal(dto.plannedQty),
        notes: dto.notes?.trim() || null,
        status: ProductionOrderStatus.DRAFT,
        createdByUserId: actorId,
      },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'CREATE',
      entityId: order.id,
      newValue: {
        productId: order.productId,
        bomId: order.bomId,
        plannedQty: dto.plannedQty,
        locationId: order.locationId,
      },
    });

    return this.mapOrder(order);
  }

  async update(id: string, tenantId: string, dto: UpdateProductionOrderDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const existing = await this.requireOrder(tenantId, id);
    if (existing.status !== ProductionOrderStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT production orders can be edited');
    }

    const productId = dto.productId ?? existing.productId;
    if (dto.productId) await this.requireProduct(tenantId, dto.productId);

    const bom = await this.resolveBom(
      tenantId,
      productId,
      dto.bomId ?? (dto.productId ? undefined : existing.bomId),
    );

    let locationId = existing.locationId;
    if (dto.locationId !== undefined) {
      const loc = await this.resolveLocation(tenantId, dto.locationId);
      locationId = loc.id;
    }

    const order = await this.prisma.productionOrder.update({
      where: { id },
      data: {
        productId,
        bomId: bom.id,
        locationId,
        ...(dto.plannedQty !== undefined ? { plannedQty: new Prisma.Decimal(dto.plannedQty) } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
      },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'UPDATE',
      entityId: order.id,
      newValue: {
        productId: order.productId,
        bomId: order.bomId,
        plannedQty: decimalToNumber(order.plannedQty),
      },
    });

    return this.mapOrder(order);
  }

  async plan(id: string, tenantId: string, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const existing = await this.requireOrder(tenantId, id);
    if (existing.status !== ProductionOrderStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT orders can be planned');
    }

    const bom = await this.requireActiveBomWithLines(tenantId, existing.productId, existing.bomId);

    const order = await this.prisma.productionOrder.update({
      where: { id },
      data: {
        status: ProductionOrderStatus.PLANNED,
        bomId: bom.id,
      },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'PLAN',
      entityId: order.id,
      newValue: { status: order.status, bomId: order.bomId },
    });

    return this.mapOrder(order);
  }

  async start(id: string, tenantId: string, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const existing = await this.requireOrder(tenantId, id);
    if (existing.status !== ProductionOrderStatus.PLANNED) {
      throw new BadRequestException('Only PLANNED orders can be started');
    }

    await this.requireActiveBomWithLines(tenantId, existing.productId, existing.bomId);

    const order = await this.prisma.productionOrder.update({
      where: { id },
      data: {
        status: ProductionOrderStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'START',
      entityId: order.id,
      newValue: { status: order.status, startedAt: order.startedAt },
    });

    return this.mapOrder(order);
  }

  async cancel(id: string, tenantId: string, dto: CancelProductionOrderDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const existing = await this.requireOrder(tenantId, id);

    const cancellable: ProductionOrderStatus[] = [
      ProductionOrderStatus.DRAFT,
      ProductionOrderStatus.PLANNED,
      ProductionOrderStatus.IN_PROGRESS,
    ];
    if (!cancellable.includes(existing.status)) {
      throw new BadRequestException('This production order cannot be cancelled');
    }

    const reason = dto.reason?.trim() || null;
    if (existing.status === ProductionOrderStatus.IN_PROGRESS && !reason) {
      throw new BadRequestException('Cancel reason is required when order is IN_PROGRESS');
    }

    const order = await this.prisma.productionOrder.update({
      where: { id },
      data: {
        status: ProductionOrderStatus.CANCELLED,
        cancelReason: reason,
      },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'CANCEL',
      entityId: order.id,
      newValue: { status: order.status, cancelReason: reason },
    });

    return this.mapOrder(order);
  }

  async complete(id: string, tenantId: string, dto: CompleteProductionOrderDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    await assertInventoryEnabled(this.prisma, tenantId);
    await assertRawMaterialsEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(tenantId, id);
    if (existing.status !== ProductionOrderStatus.IN_PROGRESS) {
      throw new BadRequestException('Only IN_PROGRESS orders can be completed');
    }

    const actualQty = Number(dto.actualQty);
    if (!Number.isFinite(actualQty) || actualQty <= 0) {
      throw new BadRequestException('actualQty must be > 0');
    }

    const planned = decimalToNumber(existing.plannedQty) ?? 0;
    const varianceNote = dto.varianceNote?.trim() || null;
    if (actualQty !== planned && !varianceNote) {
      throw new BadRequestException(
        'varianceNote is required when actualQty differs from plannedQty',
      );
    }

    const scrapQty = dto.scrapQty == null ? null : Number(dto.scrapQty);
    if (scrapQty != null && (!Number.isFinite(scrapQty) || scrapQty < 0)) {
      throw new BadRequestException('scrapQty must be >= 0');
    }

    const bomLines = existing.bom.lines;
    if (!bomLines.length) {
      throw new BadRequestException('BOM has no lines');
    }

    const actualDec = new Prisma.Decimal(actualQty);

    await this.prisma.$transaction(async (tx) => {
      for (const line of bomLines) {
        const qtyPer = new Prisma.Decimal(line.qtyPerOutputUnit);
        const consumeQty = qtyPer.mul(actualDec);
        // Signed OUT
        await this.applyRawConsume(tx, {
          tenantId,
          locationId: existing.locationId,
          rawMaterialId: line.rawMaterialId,
          quantity: consumeQty.negated(),
          actorId,
          referenceId: id,
        });

        await tx.productionConsumeLine.create({
          data: {
            tenantId,
            productionOrderId: id,
            rawMaterialId: line.rawMaterialId,
            qtyPerOutputUnit: qtyPer,
            qtyConsumed: consumeQty,
          },
        });
      }

      await this.applyFinishedProductionIn(tx, {
        tenantId,
        locationId: existing.locationId,
        productId: existing.productId,
        quantity: actualDec,
        actorId,
        referenceId: id,
      });

      await tx.productionOrder.update({
        where: { id },
        data: {
          status: ProductionOrderStatus.COMPLETED,
          actualQty: actualDec,
          scrapQty: scrapQty == null ? null : new Prisma.Decimal(scrapQty),
          varianceNote,
          scrapReason: dto.scrapReason?.trim() || null,
          completedAt: new Date(),
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'production',
      action: 'COMPLETE',
      entityId: id,
      newValue: {
        actualQty,
        plannedQty: planned,
        scrapQty,
        consumeLines: bomLines.length,
      },
    });

    return this.findOne(id, tenantId);
  }

  // ---

  private listInclude() {
    return {
      product: { select: { id: true, name: true, sku: true, baseUnit: true } },
      location: { select: { id: true, name: true, isDefault: true } },
      bom: { select: { id: true, name: true, version: true, isActive: true } },
    } as const;
  }

  private detailInclude() {
    return {
      product: { select: { id: true, name: true, sku: true, baseUnit: true } },
      location: { select: { id: true, name: true, isDefault: true } },
      bom: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: { id: true, name: true, unit: true, sku: true },
              },
            },
            orderBy: { rawMaterialId: 'asc' as const },
          },
        },
      },
      consumeLines: {
        include: {
          rawMaterial: {
            select: { id: true, name: true, unit: true, sku: true },
          },
        },
        orderBy: { rawMaterialId: 'asc' as const },
      },
    };
  }

  private async requireOrder(tenantId: string, id: string) {
    const order = await this.prisma.productionOrder.findFirst({
      where: { id, tenantId },
      include: this.detailInclude(),
    });
    if (!order) throw new NotFoundException('Production order not found');
    return order;
  }

  private async requireProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive) throw new BadRequestException('Product is inactive');
    return product;
  }

  private async resolveBom(tenantId: string, productId: string, bomId?: string) {
    if (bomId) {
      const bom = await this.prisma.bom.findFirst({
        where: { id: bomId, tenantId, productId },
        include: { lines: true },
      });
      if (!bom) throw new NotFoundException('BOM not found for this product');
      if (!bom.isActive) throw new BadRequestException('BOM is inactive');
      if (!bom.lines.length) throw new BadRequestException('BOM has no lines');
      return bom;
    }
    return this.requireActiveBomWithLines(tenantId, productId);
  }

  private async requireActiveBomWithLines(
    tenantId: string,
    productId: string,
    preferredBomId?: string,
  ) {
    if (preferredBomId) {
      const bom = await this.prisma.bom.findFirst({
        where: { id: preferredBomId, tenantId, productId },
        include: { lines: true },
      });
      if (!bom) throw new NotFoundException('BOM not found');
      if (!bom.lines.length) {
        throw new BadRequestException('BOM must have at least one line');
      }
      // Plan/start may use the locked bom even if later deactivated - still need lines
      if (!bom.isActive) {
        // On plan we prefer active; if locked bom was deactivated, try active replacement
        const active = await this.prisma.bom.findFirst({
          where: { tenantId, productId, isActive: true },
          include: { lines: true },
        });
        if (active && active.lines.length) return active;
        throw new BadRequestException('No active BOM with lines for this product');
      }
      return bom;
    }

    const bom = await this.prisma.bom.findFirst({
      where: { tenantId, productId, isActive: true },
      include: { lines: true },
    });
    if (!bom || !bom.lines.length) {
      throw new BadRequestException('Active BOM with at least one line is required');
    }
    return bom;
  }

  private async resolveLocation(tenantId: string, locationId?: string) {
    const defaultLoc = await this.inventory.ensureDefaultLocation(tenantId);
    if (!locationId) return defaultLoc;
    const loc = await this.prisma.stockLocation.findFirst({
      where: { id: locationId, tenantId, isActive: true },
      select: { id: true, name: true, isDefault: true },
    });
    if (!loc) throw new NotFoundException('Stock location not found');
    return loc;
  }

  private async applyRawConsume(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      rawMaterialId: string;
      quantity: Prisma.Decimal; // negative
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
    if (next.lessThan(0)) {
      throw new BadRequestException(
        'Insufficient raw material stock: resulting quantity would be negative',
      );
    }

    if (balance) {
      await tx.rawMaterialBalance.update({
        where: { id: balance.id },
        data: { quantity: next },
      });
    } else {
      // Creating with negative would fail next.lessThan check already
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
        type: RawMaterialMovementType.PRODUCTION_CONSUME,
        quantity: args.quantity,
        referenceType: 'ProductionOrder',
        referenceId: args.referenceId,
        createdByUserId: args.actorId,
      },
    });
  }

  private async applyFinishedProductionIn(
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
        type: StockMovementType.PRODUCTION_IN,
        quantity: args.quantity,
        referenceType: 'ProductionOrder',
        referenceId: args.referenceId,
        createdByUserId: args.actorId,
      },
    });
  }

  private mapOrder(order: {
    id: string;
    tenantId: string;
    productId: string;
    bomId: string;
    locationId: string;
    plannedQty: Prisma.Decimal;
    actualQty: Prisma.Decimal | null;
    scrapQty: Prisma.Decimal | null;
    varianceNote: string | null;
    scrapReason: string | null;
    cancelReason: string | null;
    status: ProductionOrderStatus;
    notes: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
    product?: { id: string; name: string; sku: string | null; baseUnit: string };
    location?: { id: string; name: string; isDefault: boolean };
    bom?: {
      id: string;
      name: string | null;
      version: number;
      isActive: boolean;
      lines?: Array<{
        id: string;
        rawMaterialId: string;
        qtyPerOutputUnit: Prisma.Decimal;
        rawMaterial?: { id: string; name: string; unit: string; sku: string | null };
      }>;
    };
    consumeLines?: Array<{
      id: string;
      rawMaterialId: string;
      qtyPerOutputUnit: Prisma.Decimal;
      qtyConsumed: Prisma.Decimal;
      rawMaterial?: { id: string; name: string; unit: string; sku: string | null };
    }>;
  }) {
    const plannedQty = decimalToNumber(order.plannedQty) ?? 0;
    const bomLines = order.bom?.lines ?? [];
    const expectedRaw = bomLines.map((l) => {
      const qtyPer = decimalToNumber(l.qtyPerOutputUnit) ?? 0;
      return {
        rawMaterialId: l.rawMaterialId,
        rawMaterial: l.rawMaterial,
        qtyPerOutputUnit: qtyPer,
        expectedQty: qtyPer * plannedQty,
      };
    });

    return {
      id: order.id,
      tenantId: order.tenantId,
      productId: order.productId,
      bomId: order.bomId,
      locationId: order.locationId,
      plannedQty,
      actualQty: decimalToNumber(order.actualQty),
      scrapQty: decimalToNumber(order.scrapQty),
      varianceNote: order.varianceNote,
      scrapReason: order.scrapReason,
      cancelReason: order.cancelReason,
      status: order.status,
      notes: order.notes,
      startedAt: order.startedAt,
      completedAt: order.completedAt,
      createdByUserId: order.createdByUserId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      product: order.product,
      location: order.location,
      bom: order.bom
        ? {
            id: order.bom.id,
            name: order.bom.name,
            version: order.bom.version,
            isActive: order.bom.isActive,
            lines: bomLines.map((l) => ({
              id: l.id,
              rawMaterialId: l.rawMaterialId,
              qtyPerOutputUnit: decimalToNumber(l.qtyPerOutputUnit) ?? 0,
              rawMaterial: l.rawMaterial,
            })),
          }
        : undefined,
      expectedRaw,
      consumeLines: (order.consumeLines ?? []).map((c) => ({
        id: c.id,
        rawMaterialId: c.rawMaterialId,
        qtyPerOutputUnit: decimalToNumber(c.qtyPerOutputUnit) ?? 0,
        qtyConsumed: decimalToNumber(c.qtyConsumed) ?? 0,
        rawMaterial: c.rawMaterial,
      })),
    };
  }
}
