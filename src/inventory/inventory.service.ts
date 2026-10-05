import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockLocationType, StockMovementType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import {
  assertInventoryEnabled,
  assertWarehouseEnabled,
  isWarehouseEnabled,
  WAREHOUSE_DISABLED_MESSAGE,
} from '../common/helpers/inventory.helper';
import { CreateStockLocationDto, UpdateStockLocationDto } from './dto/stock-location.dto';
import { PostAdjustmentDto, PostOpeningStockDto, PostTransferDto } from './dto/stock-movements.dto';
import {
  ListBalancesQueryDto,
  ListLocationsQueryDto,
  ListMovementsQueryDto,
} from './dto/list-inventory-query.dto';

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

const locationSelect = {
  id: true,
  name: true,
  type: true,
  code: true,
  notes: true,
  isActive: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Finished-goods warehouse inventory.
 * Never reads/writes DeliveryRunStock (truck OPENING/CLOSING).
 * SALE_OUT posted from Orders.place when inventory ON (POS module not shipped).
 * PURCHASE_IN / PRODUCTION_* from GRN / production complete.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  // ---

  async listLocations(tenantId: string, query: ListLocationsQueryDto) {
    await assertInventoryEnabled(this.prisma, tenantId);
    await this.ensureDefaultLocation(tenantId);

    const where: Prisma.StockLocationWhereInput = { tenantId };
    if (query.isActive != null) where.isActive = query.isActive;

    const rows = await this.prisma.stockLocation.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: locationSelect,
    });
    return rows;
  }

  async createLocation(tenantId: string, dto: CreateStockLocationDto, actorId: string) {
    await assertWarehouseEnabled(this.prisma, tenantId);
    await this.ensureDefaultLocation(tenantId);

    const location = await this.prisma.stockLocation.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        type: dto.type ?? StockLocationType.WAREHOUSE,
        code: dto.code?.trim() || null,
        notes: dto.notes?.trim() || null,
        isDefault: false,
      },
      select: locationSelect,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'inventory',
      action: 'CREATE_LOCATION',
      entityId: location.id,
      newValue: { name: location.name, type: location.type },
    });

    return location;
  }

  async updateLocation(tenantId: string, id: string, dto: UpdateStockLocationDto, actorId: string) {
    await assertInventoryEnabled(this.prisma, tenantId);
    const warehouseOn = await isWarehouseEnabled(this.prisma, tenantId);
    const existing = await this.requireLocation(tenantId, id);

    if (!warehouseOn) {
      // Single-location mode: allow rename/notes only; no deactivate of the only location
      if (dto.isActive === false) {
        throw new ForbiddenException(WAREHOUSE_DISABLED_MESSAGE);
      }
      if (dto.type != null && dto.type !== existing.type) {
        throw new ForbiddenException(WAREHOUSE_DISABLED_MESSAGE);
      }
    }

    if (dto.isActive === false && existing.isDefault) {
      const otherActive = await this.prisma.stockLocation.count({
        where: { tenantId, isActive: true, id: { not: id } },
      });
      if (otherActive === 0) {
        throw new BadRequestException('Cannot deactivate the only active stock location');
      }
    }

    const updated = await this.prisma.stockLocation.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.code !== undefined ? { code: dto.code?.trim() || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
      },
      select: locationSelect,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'inventory',
      action: 'UPDATE_LOCATION',
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: updated.name, isActive: updated.isActive },
    });

    return updated;
  }

  // ---

  /**
   * When warehouse flag is OFF but multiple locations already exist (flag was ON before):
   * - reads: list balances across locations (no forced filter to default)
   * - writes: opening/adjust may target any active location by id
   * - create location + transfer remain blocked via assertWarehouseEnabled
   */
  async listBalances(tenantId: string, query: ListBalancesQueryDto) {
    await assertInventoryEnabled(this.prisma, tenantId);
    const defaultLoc = await this.ensureDefaultLocation(tenantId);
    const warehouseOn = await isWarehouseEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    // Only force default location when warehouse OFF and caller did not pass locationId
    // AND there is exactly one active location. If multiple remain after flag-off, show all.
    let locationId = query.locationId;
    if (!locationId && !warehouseOn) {
      const activeCount = await this.prisma.stockLocation.count({
        where: { tenantId, isActive: true },
      });
      if (activeCount <= 1) locationId = defaultLoc.id;
    }

    const where: Prisma.StockBalanceWhereInput = {
      tenantId,
      ...(locationId ? { locationId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.lowStockOnly
        ? {
            product: { reorderLevel: { not: null } },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where,
        skip,
        take,
        orderBy: [{ updatedAt: 'desc' }],
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              baseUnit: true,
              reorderLevel: true,
            },
          },
          location: { select: locationSelect },
        },
      }),
      this.prisma.stockBalance.count({ where }),
    ]);

    let items = rows.map((r) => this.mapBalance(r));
    if (query.lowStockOnly) {
      items = items.filter(
        (r) => r.product.reorderLevel != null && r.quantity <= r.product.reorderLevel,
      );
    }

    return {
      items,
      meta: buildPaginationMeta(query.lowStockOnly ? items.length : total, page, limit),
    };
  }

  // ---

  async listMovements(tenantId: string, query: ListMovementsQueryDto) {
    await assertInventoryEnabled(this.prisma, tenantId);
    await this.ensureDefaultLocation(tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where: Prisma.StockMovementWhereInput = {
      tenantId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.type ? { type: query.type } : {}),
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
      this.prisma.stockMovement.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { id: true, name: true, sku: true, baseUnit: true } },
          location: { select: locationSelect },
          createdBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return {
      items: rows.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: decimalToNumber(m.quantity),
        reason: m.reason,
        transferGroupId: m.transferGroupId,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        createdAt: m.createdAt,
        product: m.product,
        location: m.location,
        createdBy: m.createdBy,
      })),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async postOpening(tenantId: string, dto: PostOpeningStockDto, actorId: string) {
    await assertInventoryEnabled(this.prisma, tenantId);
    const location = await this.resolveWriteLocation(tenantId, dto.locationId);

    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    await this.assertProducts(tenantId, productIds);

    const movements = await this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const line of dto.lines) {
        if (line.quantity <= 0) {
          throw new BadRequestException('Opening quantity must be greater than 0');
        }
        const qty = new Prisma.Decimal(line.quantity);
        created.push(
          await this.applyMovement(tx, {
            tenantId,
            locationId: location.id,
            productId: line.productId,
            type: StockMovementType.OPENING,
            quantity: qty,
            actorId,
          }),
        );
      }
      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'inventory',
      action: 'OPENING',
      entityId: location.id,
      newValue: {
        locationId: location.id,
        lines: dto.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
        })),
      },
    });

    return { locationId: location.id, movements: movements.map((m) => this.mapMovement(m)) };
  }

  async postAdjustment(tenantId: string, dto: PostAdjustmentDto, actorId: string) {
    await assertInventoryEnabled(this.prisma, tenantId);
    const location = await this.resolveWriteLocation(tenantId, dto.locationId);
    await this.assertProducts(tenantId, [dto.productId]);

    const reason = dto.reason?.trim();
    if (!reason) {
      throw new BadRequestException('Adjustment reason is required');
    }
    if (dto.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta must not be 0');
    }

    const movement = await this.prisma.$transaction(async (tx) => {
      return this.applyMovement(tx, {
        tenantId,
        locationId: location.id,
        productId: dto.productId,
        type: StockMovementType.ADJUSTMENT,
        quantity: new Prisma.Decimal(dto.quantityDelta),
        reason,
        actorId,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'inventory',
      action: 'ADJUST',
      entityId: movement.id,
      newValue: {
        locationId: location.id,
        productId: dto.productId,
        quantityDelta: dto.quantityDelta,
        reason,
      },
    });

    return this.mapMovement(movement);
  }

  async postTransfer(tenantId: string, dto: PostTransferDto, actorId: string) {
    await assertWarehouseEnabled(this.prisma, tenantId);

    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('fromLocationId and toLocationId must differ');
    }
    if (dto.quantity <= 0) {
      throw new BadRequestException('Transfer quantity must be greater than 0');
    }

    await this.requireLocation(tenantId, dto.fromLocationId, true);
    await this.requireLocation(tenantId, dto.toLocationId, true);
    await this.assertProducts(tenantId, [dto.productId]);

    const transferGroupId = randomUUID();
    const qty = new Prisma.Decimal(dto.quantity);

    const result = await this.prisma.$transaction(async (tx) => {
      const out = await this.applyMovement(tx, {
        tenantId,
        locationId: dto.fromLocationId,
        productId: dto.productId,
        type: StockMovementType.TRANSFER_OUT,
        quantity: qty.neg(),
        transferGroupId,
        actorId,
      });
      const inn = await this.applyMovement(tx, {
        tenantId,
        locationId: dto.toLocationId,
        productId: dto.productId,
        type: StockMovementType.TRANSFER_IN,
        quantity: qty,
        transferGroupId,
        actorId,
      });
      return { out, inn };
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'inventory',
      action: 'TRANSFER',
      entityId: transferGroupId,
      newValue: {
        fromLocationId: dto.fromLocationId,
        toLocationId: dto.toLocationId,
        productId: dto.productId,
        quantity: dto.quantity,
        transferGroupId,
      },
    });

    return {
      transferGroupId,
      out: this.mapMovement(result.out),
      in: this.mapMovement(result.inn),
    };
  }

  // ---

  /**
   * Auto-create single default "Main" location when inventory is used and none exist.
   * warehouse != DeliveryRunStock.
   */
  async ensureDefaultLocation(tenantId: string) {
    const existing = await this.prisma.stockLocation.findFirst({
      where: { tenantId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: locationSelect,
    });
    if (existing) return existing;

    return this.prisma.stockLocation.create({
      data: {
        tenantId,
        name: 'Main',
        type: StockLocationType.WAREHOUSE,
        isDefault: true,
        isActive: true,
      },
      select: locationSelect,
    });
  }

  private async resolveWriteLocation(tenantId: string, locationId?: string) {
    const defaultLoc = await this.ensureDefaultLocation(tenantId);
    // Warehouse OFF: still allow writing to any existing active location by id
    // (legacy multi-location after flag turned off). Block only create/transfer.
    if (!locationId) return defaultLoc;
    return this.requireLocation(tenantId, locationId, true);
  }

  private async requireLocation(tenantId: string, id: string, activeOnly = false) {
    const loc = await this.prisma.stockLocation.findFirst({
      where: { id, tenantId, ...(activeOnly ? { isActive: true } : {}) },
      select: locationSelect,
    });
    if (!loc) throw new NotFoundException('Stock location not found');
    return loc;
  }

  private async assertProducts(tenantId: string, productIds: string[]) {
    const count = await this.prisma.product.count({
      where: { tenantId, id: { in: productIds }, deletedAt: null },
    });
    if (count !== productIds.length) {
      throw new BadRequestException('One or more products were not found');
    }
  }

  private async applyMovement(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      productId: string;
      type: StockMovementType;
      quantity: Prisma.Decimal;
      reason?: string;
      transferGroupId?: string;
      actorId: string;
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
    if (next.lessThan(0)) {
      throw new BadRequestException('Insufficient stock: resulting quantity would be negative');
    }

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

    return tx.stockMovement.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: args.productId,
        type: args.type,
        quantity: args.quantity,
        reason: args.reason ?? null,
        transferGroupId: args.transferGroupId ?? null,
        createdByUserId: args.actorId,
      },
    });
  }

  private mapBalance(r: {
    id: string;
    quantity: Prisma.Decimal;
    updatedAt: Date;
    product: {
      id: string;
      name: string;
      sku: string | null;
      baseUnit: string;
      reorderLevel: Prisma.Decimal | null;
    };
    location: {
      id: string;
      name: string;
      type: StockLocationType;
      isDefault: boolean;
      isActive: boolean;
    };
  }) {
    const quantity = decimalToNumber(r.quantity);
    const reorderLevel =
      r.product.reorderLevel == null ? null : decimalToNumber(r.product.reorderLevel);
    return {
      id: r.id,
      quantity,
      updatedAt: r.updatedAt,
      isLowStock: reorderLevel != null && quantity <= reorderLevel,
      product: {
        id: r.product.id,
        name: r.product.name,
        sku: r.product.sku,
        baseUnit: r.product.baseUnit,
        reorderLevel,
      },
      location: r.location,
    };
  }

  private mapMovement(m: {
    id: string;
    type: StockMovementType;
    quantity: Prisma.Decimal;
    reason: string | null;
    transferGroupId: string | null;
    locationId: string;
    productId: string;
    createdAt: Date;
  }) {
    return {
      id: m.id,
      type: m.type,
      quantity: decimalToNumber(m.quantity),
      reason: m.reason,
      transferGroupId: m.transferGroupId,
      locationId: m.locationId,
      productId: m.productId,
      createdAt: m.createdAt,
    };
  }
}
