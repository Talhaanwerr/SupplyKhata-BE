import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RawMaterialMovementType, RawMaterialUnit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InventoryService } from '../inventory/inventory.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { isWarehouseEnabled } from '../common/helpers/inventory.helper';
import { assertRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';
import { CreateRawMaterialDto, UpdateRawMaterialDto } from './dto/raw-material.dto';
import {
  ListRawBalancesQueryDto,
  ListRawMaterialsQueryDto,
  ListRawMovementsQueryDto,
} from './dto/list-raw-materials-query.dto';
import { PostRawAdjustmentDto, PostRawOpeningDto } from './dto/raw-stock-movements.dto';
import {
  parseCalendarDateUtc,
  startOfTodayInTimeZoneUtc,
} from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number | null {
  if (value == null) return null;
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
  isActive: true,
  isDefault: true,
} as const;

/**
 * Raw materials master + stock by StockLocation.
 * Never reads/writes DeliveryRunStock. PURCHASE_IN / PRODUCTION_CONSUME callers later.
 */
@Injectable()
export class RawMaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inventory: InventoryService,
  ) {}

  // ─── Master ──────────────────────────────────────────────────

  async list(tenantId: string, query: ListRawMaterialsQueryDto) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const lowStockOnly = !!query.lowStockOnly;

    const where: Prisma.RawMaterialWhereInput = {
      tenantId,
      ...(query.isActive != null ? { isActive: query.isActive } : {}),
      ...(query.search?.trim()
        ? {
            OR: [
              { name: { contains: query.search.trim() } },
              { sku: { contains: query.search.trim() } },
            ],
          }
        : {}),
      ...(lowStockOnly ? { reorderLevel: { not: null } } : {}),
    };

    // lowStockOnly needs on-hand before paginating; keep cap for safety.
    const rows = await this.prisma.rawMaterial.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: lowStockOnly ? 0 : (page - 1) * limit,
      take: lowStockOnly ? 500 : limit,
    });
    const totalAll = lowStockOnly ? rows.length : await this.prisma.rawMaterial.count({ where });

    const ids = rows.map((r) => r.id);
    const grouped =
      ids.length === 0
        ? []
        : await this.prisma.rawMaterialBalance.groupBy({
            by: ['rawMaterialId'],
            where: { tenantId, rawMaterialId: { in: ids } },
            _sum: { quantity: true },
          });
    const onHandById = new Map(
      grouped.map((g) => [g.rawMaterialId, decimalToNumber(g._sum.quantity) ?? 0]),
    );

    let items = rows.map((r) => {
      const onHandQty = onHandById.get(r.id) ?? 0;
      const reorder = decimalToNumber(r.reorderLevel);
      const isLowStock = reorder != null && onHandQty <= reorder;
      return {
        ...this.mapRawMaterial(r),
        onHandQty,
        isLowStock,
      };
    });

    if (lowStockOnly) {
      items = items.filter((r) => r.isLowStock);
      const total = items.length;
      const start = (page - 1) * limit;
      items = items.slice(start, start + limit);
      return { items, meta: buildPaginationMeta(total, page, limit) };
    }

    return {
      items,
      meta: buildPaginationMeta(totalAll, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    const row = await this.requireRawMaterial(tenantId, id);
    const balances = await this.prisma.rawMaterialBalance.findMany({
      where: { tenantId, rawMaterialId: id },
      include: { location: { select: locationSelect } },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      ...this.mapRawMaterial(row),
      balances: balances.map((b) => ({
        id: b.id,
        locationId: b.locationId,
        quantity: decimalToNumber(b.quantity) ?? 0,
        location: b.location,
        updatedAt: b.updatedAt,
      })),
    };
  }

  async create(tenantId: string, dto: CreateRawMaterialDto, actorId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);

    const row = await this.prisma.rawMaterial.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        unit: dto.unit,
        sku: dto.sku?.trim() || null,
        defaultCost: dto.defaultCost != null ? new Prisma.Decimal(dto.defaultCost) : null,
        reorderLevel: dto.reorderLevel != null ? new Prisma.Decimal(dto.reorderLevel) : null,
        notes: dto.notes?.trim() || null,
        isActive: dto.isActive ?? true,
      },
    });

    if (dto.defaultCost != null && dto.defaultCost >= 0) {
      await this.prisma.rawMaterialCostHistory.create({
        data: {
          tenantId,
          rawMaterialId: row.id,
          costPerUnit: new Prisma.Decimal(dto.defaultCost),
          effectiveFrom: startOfTodayInTimeZoneUtc(await getTenantTimezone(this.prisma, tenantId)),
          notes: 'Initial cost',
          createdById: actorId,
        },
      });
    }

    await this.audit.write({
      tenantId,
      actorId,
      module: 'raw-materials',
      action: 'CREATE',
      entityId: row.id,
      newValue: { name: row.name, unit: row.unit, isActive: row.isActive },
    });

    return this.mapRawMaterial(row);
  }

  async listCosts(id: string, tenantId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    await this.requireRawMaterial(tenantId, id);
    const rows = await this.prisma.rawMaterialCostHistory.findMany({
      where: { tenantId, rawMaterialId: id },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      rawMaterialId: r.rawMaterialId,
      costPerUnit: decimalToNumber(r.costPerUnit) ?? 0,
      effectiveFrom: r.effectiveFrom,
      notes: r.notes,
      createdById: r.createdById,
      createdAt: r.createdAt,
    }));
  }

  async addCost(
    id: string,
    tenantId: string,
    dto: { costPerUnit: number; effectiveFrom?: string; notes?: string | null },
    actorId: string,
  ) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    await this.requireRawMaterial(tenantId, id);

    const tz = await getTenantTimezone(this.prisma, tenantId);
    const effectiveFrom = dto.effectiveFrom
      ? parseCalendarDateUtc(dto.effectiveFrom, false)
      : startOfTodayInTimeZoneUtc(tz);
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom date');
    }

    const cost = await this.prisma.$transaction(async (tx) => {
      const created = await tx.rawMaterialCostHistory.create({
        data: {
          tenantId,
          rawMaterialId: id,
          costPerUnit: new Prisma.Decimal(dto.costPerUnit),
          effectiveFrom,
          notes: dto.notes?.trim() || null,
          createdById: actorId,
        },
      });

      // Keep defaultCost in sync with latest effective cost (for PO prefill).
      const latest = await tx.rawMaterialCostHistory.findFirst({
        where: { tenantId, rawMaterialId: id },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      });
      if (latest) {
        await tx.rawMaterial.update({
          where: { id },
          data: { defaultCost: latest.costPerUnit },
        });
      }

      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'raw-materials',
      action: 'UPDATE',
      entityId: id,
      newValue: {
        costEntryId: cost.id,
        costPerUnit: dto.costPerUnit,
        effectiveFrom: effectiveFrom.toISOString(),
      },
    });

    return {
      id: cost.id,
      tenantId: cost.tenantId,
      rawMaterialId: cost.rawMaterialId,
      costPerUnit: decimalToNumber(cost.costPerUnit) ?? 0,
      effectiveFrom: cost.effectiveFrom,
      notes: cost.notes,
      createdById: cost.createdById,
      createdAt: cost.createdAt,
    };
  }

  async update(id: string, tenantId: string, dto: UpdateRawMaterialDto, actorId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    const existing = await this.requireRawMaterial(tenantId, id);

    const prevCost = decimalToNumber(existing.defaultCost);
    const costChanging =
      dto.defaultCost !== undefined && dto.defaultCost != null && dto.defaultCost !== prevCost;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.rawMaterial.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
          ...(dto.sku !== undefined ? { sku: dto.sku?.trim() || null } : {}),
          ...(dto.defaultCost !== undefined
            ? {
                defaultCost: dto.defaultCost != null ? new Prisma.Decimal(dto.defaultCost) : null,
              }
            : {}),
          ...(dto.reorderLevel !== undefined
            ? {
                reorderLevel:
                  dto.reorderLevel != null ? new Prisma.Decimal(dto.reorderLevel) : null,
              }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      if (costChanging && dto.defaultCost != null) {
        await tx.rawMaterialCostHistory.create({
          data: {
            tenantId,
            rawMaterialId: id,
            costPerUnit: new Prisma.Decimal(dto.defaultCost),
            effectiveFrom: startOfTodayInTimeZoneUtc(
              await getTenantTimezone(this.prisma, tenantId),
            ),
            notes: 'Updated via edit',
            createdById: actorId,
          },
        });
      }

      return row;
    });

    const action =
      dto.isActive === false && existing.isActive
        ? 'DEACTIVATE'
        : dto.isActive === true && !existing.isActive
          ? 'ACTIVATE'
          : 'UPDATE';

    await this.audit.write({
      tenantId,
      actorId,
      module: 'raw-materials',
      action,
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: updated.name, isActive: updated.isActive },
    });

    return this.mapRawMaterial(updated);
  }

  // ─── Stock ───────────────────────────────────────────────────

  async listBalances(tenantId: string, query: ListRawBalancesQueryDto) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    const defaultLoc = await this.inventory.ensureDefaultLocation(tenantId);
    const warehouseOn = await isWarehouseEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    let locationId = query.locationId;
    if (!locationId && !warehouseOn) {
      const activeCount = await this.prisma.stockLocation.count({
        where: { tenantId, isActive: true },
      });
      if (activeCount <= 1) locationId = defaultLoc.id;
    }

    const where: Prisma.RawMaterialBalanceWhereInput = {
      tenantId,
      ...(locationId ? { locationId } : {}),
      ...(query.rawMaterialId ? { rawMaterialId: query.rawMaterialId } : {}),
      ...(query.lowStockOnly ? { rawMaterial: { reorderLevel: { not: null } } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.rawMaterialBalance.findMany({
        where,
        skip,
        take,
        orderBy: [{ updatedAt: 'desc' }],
        include: {
          rawMaterial: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
              reorderLevel: true,
              isActive: true,
            },
          },
          location: { select: locationSelect },
        },
      }),
      this.prisma.rawMaterialBalance.count({ where }),
    ]);

    let items = rows.map((r) => ({
      id: r.id,
      quantity: decimalToNumber(r.quantity) ?? 0,
      locationId: r.locationId,
      rawMaterialId: r.rawMaterialId,
      updatedAt: r.updatedAt,
      rawMaterial: {
        ...r.rawMaterial,
        reorderLevel: decimalToNumber(r.rawMaterial.reorderLevel),
      },
      location: r.location,
    }));

    if (query.lowStockOnly) {
      items = items.filter(
        (r) => r.rawMaterial.reorderLevel != null && r.quantity <= r.rawMaterial.reorderLevel,
      );
    }

    return {
      items,
      meta: buildPaginationMeta(query.lowStockOnly ? items.length : total, page, limit),
    };
  }

  async listMovements(tenantId: string, query: ListRawMovementsQueryDto) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    await this.inventory.ensureDefaultLocation(tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.RawMaterialMovementWhereInput = {
      tenantId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.rawMaterialId ? { rawMaterialId: query.rawMaterialId } : {}),
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
      this.prisma.rawMaterialMovement.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          rawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
          location: { select: locationSelect },
          createdBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.rawMaterialMovement.count({ where }),
    ]);

    return {
      items: rows.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: decimalToNumber(m.quantity) ?? 0,
        reason: m.reason,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        createdAt: m.createdAt,
        rawMaterial: m.rawMaterial,
        location: m.location,
        createdBy: m.createdBy,
      })),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async postOpening(tenantId: string, dto: PostRawOpeningDto, actorId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    const location = await this.resolveWriteLocation(tenantId, dto.locationId);
    const ids = [...new Set(dto.lines.map((l) => l.rawMaterialId))];
    await this.assertRawMaterials(tenantId, ids);

    const movements = await this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const line of dto.lines) {
        if (line.quantity <= 0) {
          throw new BadRequestException('Opening quantity must be greater than 0');
        }
        created.push(
          await this.applyMovement(tx, {
            tenantId,
            locationId: location.id,
            rawMaterialId: line.rawMaterialId,
            type: RawMaterialMovementType.OPENING,
            quantity: new Prisma.Decimal(line.quantity),
            actorId,
          }),
        );
      }
      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'raw-materials',
      action: 'OPENING',
      entityId: location.id,
      newValue: {
        locationId: location.id,
        lines: dto.lines.map((l) => ({
          rawMaterialId: l.rawMaterialId,
          quantity: l.quantity,
        })),
      },
    });

    return {
      locationId: location.id,
      movements: movements.map((m) => this.mapMovement(m)),
    };
  }

  async postAdjustment(tenantId: string, dto: PostRawAdjustmentDto, actorId: string) {
    await assertRawMaterialsEnabled(this.prisma, tenantId);
    const location = await this.resolveWriteLocation(tenantId, dto.locationId);
    await this.assertRawMaterials(tenantId, [dto.rawMaterialId]);

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
        rawMaterialId: dto.rawMaterialId,
        type: RawMaterialMovementType.ADJUSTMENT,
        quantity: new Prisma.Decimal(dto.quantityDelta),
        reason,
        actorId,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'raw-materials',
      action: 'ADJUST',
      entityId: dto.rawMaterialId,
      newValue: {
        locationId: location.id,
        rawMaterialId: dto.rawMaterialId,
        quantityDelta: dto.quantityDelta,
        reason,
      },
    });

    return this.mapMovement(movement);
  }

  // ─── Internals ───────────────────────────────────────────────

  private async resolveWriteLocation(tenantId: string, locationId?: string) {
    const defaultLoc = await this.inventory.ensureDefaultLocation(tenantId);
    if (!locationId) return defaultLoc;
    const loc = await this.prisma.stockLocation.findFirst({
      where: { id: locationId, tenantId, isActive: true },
      select: locationSelect,
    });
    if (!loc) throw new NotFoundException('Stock location not found');
    return loc;
  }

  private async requireRawMaterial(tenantId: string, id: string) {
    const row = await this.prisma.rawMaterial.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('Raw material not found');
    return row;
  }

  private async assertRawMaterials(tenantId: string, ids: string[]) {
    const count = await this.prisma.rawMaterial.count({
      where: { tenantId, id: { in: ids } },
    });
    if (count !== ids.length) {
      throw new BadRequestException('One or more raw materials were not found');
    }
  }

  private async applyMovement(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      rawMaterialId: string;
      type: RawMaterialMovementType;
      quantity: Prisma.Decimal;
      reason?: string;
      actorId: string;
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
      throw new BadRequestException('Insufficient stock: resulting quantity would be negative');
    }

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

    return tx.rawMaterialMovement.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        rawMaterialId: args.rawMaterialId,
        type: args.type,
        quantity: args.quantity,
        reason: args.reason ?? null,
        createdByUserId: args.actorId,
      },
    });
  }

  private mapRawMaterial(r: {
    id: string;
    tenantId: string;
    name: string;
    unit: RawMaterialUnit;
    sku: string | null;
    defaultCost: Prisma.Decimal | null;
    reorderLevel: Prisma.Decimal | null;
    notes: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      tenantId: r.tenantId,
      name: r.name,
      unit: r.unit,
      sku: r.sku,
      defaultCost: decimalToNumber(r.defaultCost),
      reorderLevel: decimalToNumber(r.reorderLevel),
      notes: r.notes,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private mapMovement(m: {
    id: string;
    type: RawMaterialMovementType;
    quantity: Prisma.Decimal;
    reason: string | null;
    locationId: string;
    rawMaterialId: string;
    createdAt: Date;
  }) {
    return {
      id: m.id,
      type: m.type,
      quantity: decimalToNumber(m.quantity) ?? 0,
      reason: m.reason,
      locationId: m.locationId,
      rawMaterialId: m.rawMaterialId,
      createdAt: m.createdAt,
    };
  }
}
