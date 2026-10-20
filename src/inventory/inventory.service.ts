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
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import {
  assertInventoryEnabled,
  assertWarehouseEnabled,
  isWarehouseEnabled,
  WAREHOUSE_DISABLED_MESSAGE,
} from '../common/helpers/inventory.helper';
import { applyProductStockMovement } from '../common/helpers/stock-apply.helper';
import { isRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';

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
  const parsed = parseCalendarDateUtc(value, false);
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
    private readonly notifications: NotificationsService,
  ) {}

  // ---

  /**
   * Create one WARNING notification for the current user summarizing low-stock rows.
   * Does not auto-push on every stock move (keeps v1 simple).
   */
  async notifyLowStockAlerts(tenantId: string, userId: string) {
    await assertInventoryEnabled(this.prisma, tenantId);

    const productRows = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(*) AS total
      FROM stock_balances sb
      INNER JOIN products p ON p.id = sb.productId
      WHERE sb.tenantId = ${tenantId}
        AND p.reorderLevel IS NOT NULL
        AND sb.quantity <= p.reorderLevel
    `;
    const productLow = Number(productRows[0]?.total ?? 0);

    let rawLow = 0;
    if (await isRawMaterialsEnabled(this.prisma, tenantId)) {
      const rawRows = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT COUNT(*) AS total
        FROM raw_material_balances rmb
        INNER JOIN raw_materials rm ON rm.id = rmb.rawMaterialId
        WHERE rmb.tenantId = ${tenantId}
          AND rm.reorderLevel IS NOT NULL
          AND rmb.quantity <= rm.reorderLevel
      `;
      rawLow = Number(rawRows[0]?.total ?? 0);
    }

    if (productLow === 0 && rawLow === 0) {
      return {
        notified: false,
        productLow: 0,
        rawLow: 0,
        message: 'No low-stock items',
      };
    }

    await this.notifications.create(
      {
        userId,
        title: 'Low stock alert',
        body: `${productLow} product balance(s) and ${rawLow} raw material balance(s) are at or below reorder level.`,
        type: NotificationType.WARNING,
        link: '/inventory/alerts',
      },
      tenantId,
    );

    return {
      notified: true,
      productLow,
      rawLow,
      message: 'Notification created',
    };
  }

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

    const balanceInclude = {
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
    } as const;

    // Prisma cannot express quantity <= product.reorderLevel; use SQL JOIN + LIMIT/OFFSET.
    if (query.lowStockOnly) {
      const locationFilter = locationId
        ? Prisma.sql`AND sb.locationId = ${locationId}`
        : Prisma.empty;
      const productFilter = query.productId
        ? Prisma.sql`AND sb.productId = ${query.productId}`
        : Prisma.empty;

      const [countRows, idRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
          SELECT COUNT(*) AS total
          FROM stock_balances sb
          INNER JOIN products p ON p.id = sb.productId
          WHERE sb.tenantId = ${tenantId}
            AND p.reorderLevel IS NOT NULL
            AND sb.quantity <= p.reorderLevel
            ${locationFilter}
            ${productFilter}
        `,
        this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT sb.id AS id
          FROM stock_balances sb
          INNER JOIN products p ON p.id = sb.productId
          WHERE sb.tenantId = ${tenantId}
            AND p.reorderLevel IS NOT NULL
            AND sb.quantity <= p.reorderLevel
            ${locationFilter}
            ${productFilter}
          ORDER BY sb.updatedAt DESC
          LIMIT ${take} OFFSET ${skip}
        `,
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) {
        return { items: [], meta: buildPaginationMeta(total, page, limit) };
      }

      const rows = await this.prisma.stockBalance.findMany({
        where: { id: { in: ids } },
        include: balanceInclude,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items = ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map((r) => this.mapBalance(r));

      return {
        items,
        meta: buildPaginationMeta(total, page, limit),
      };
    }

    const where: Prisma.StockBalanceWhereInput = {
      tenantId,
      ...(locationId ? { locationId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where,
        skip,
        take,
        orderBy: [{ updatedAt: 'desc' }],
        include: balanceInclude,
      }),
      this.prisma.stockBalance.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.mapBalance(r)),
      meta: buildPaginationMeta(total, page, limit),
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

  /**
   * Transfer history: one row per transferGroupId (paired OUT + IN).
   */
  async listTransfers(tenantId: string, query: { page?: number; limit?: number }) {
    await assertWarehouseEnabled(this.prisma, tenantId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const { skip, take } = getPaginationParams({ page, limit });

    const where: Prisma.StockMovementWhereInput = {
      tenantId,
      type: StockMovementType.TRANSFER_OUT,
      transferGroupId: { not: null },
    };

    const [outs, total] = await Promise.all([
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

    const groupIds = outs.map((o) => o.transferGroupId).filter((id): id is string => !!id);

    const ins =
      groupIds.length === 0
        ? []
        : await this.prisma.stockMovement.findMany({
            where: {
              tenantId,
              type: StockMovementType.TRANSFER_IN,
              transferGroupId: { in: groupIds },
            },
            include: {
              location: { select: locationSelect },
            },
          });
    const inByGroup = new Map(ins.map((m) => [m.transferGroupId!, m]));

    const items = outs.map((out) => {
      const inn = out.transferGroupId ? inByGroup.get(out.transferGroupId) : undefined;
      return {
        transferGroupId: out.transferGroupId!,
        createdAt: out.createdAt,
        quantity: Math.abs(decimalToNumber(out.quantity)),
        product: out.product,
        fromLocation: out.location,
        toLocation: inn?.location ?? null,
        createdBy: out.createdBy,
      };
    });

    return {
      items,
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async getTransfer(tenantId: string, transferGroupId: string) {
    await assertWarehouseEnabled(this.prisma, tenantId);

    const rows = await this.prisma.stockMovement.findMany({
      where: { tenantId, transferGroupId },
      include: {
        product: { select: { id: true, name: true, sku: true, baseUnit: true } },
        location: { select: locationSelect },
        createdBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (rows.length === 0) {
      throw new NotFoundException('Transfer not found');
    }

    const out = rows.find((r) => r.type === StockMovementType.TRANSFER_OUT);
    const inn = rows.find((r) => r.type === StockMovementType.TRANSFER_IN);
    if (!out || !inn) {
      throw new NotFoundException('Transfer pair incomplete');
    }

    return {
      transferGroupId,
      createdAt: out.createdAt,
      quantity: Math.abs(decimalToNumber(out.quantity)),
      product: out.product,
      fromLocation: out.location,
      toLocation: inn.location,
      createdBy: out.createdBy,
      outMovementId: out.id,
      inMovementId: inn.id,
    };
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
    return applyProductStockMovement(tx, {
      tenantId: args.tenantId,
      locationId: args.locationId,
      productId: args.productId,
      type: args.type,
      quantity: args.quantity,
      reason: args.reason,
      transferGroupId: args.transferGroupId,
      actorId: args.actorId,
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
