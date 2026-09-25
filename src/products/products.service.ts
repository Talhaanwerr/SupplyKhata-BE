import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, ProductBaseUnit as PrismaProductBaseUnit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ProductBaseUnit } from '../common/enums/product.enum';
import { normalizePackFields } from '../common/helpers/product-qty.helper';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { CreateProductCostDto } from './dto/create-product-cost.dto';

function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

/**
 * Cost dates are calendar days, stored as UTC midnight for that Y-M-D.
 * Resolving "current" uses end of today's local calendar day in UTC so
 * same-day entries always count (avoids PKT/UTC midnight bugs).
 */
function parseCalendarDateUtc(value: string, endOfDay = false): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const parsed = new Date(value);
    return parsed;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return endOfDay
    ? new Date(Date.UTC(year, month, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

/** End of the user's local calendar "today", expressed in UTC. */
function endOfLocalTodayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
}

/** Start of the user's local calendar "today", expressed in UTC. */
function startOfLocalTodayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
}

function formatCalendarDateUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultUnitLabel(baseUnit: ProductBaseUnit | PrismaProductBaseUnit): string {
  switch (baseUnit) {
    case ProductBaseUnit.LTR:
    case 'LTR':
      return 'L';
    case ProductBaseUnit.KG:
    case 'KG':
      return 'kg';
    default:
      return 'pcs';
  }
}

export type ProductCostItem = {
  id: string;
  tenantId: string;
  productId: string;
  costPerUnit: number;
  effectiveFrom: Date;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
};

export type ProductItem = {
  id: string;
  tenantId: string;
  name: string;
  volume: number | null;
  unit: string | null;
  sku: string | null;
  isActive: boolean;
  isReturnable: boolean;
  containerType: string | null;
  defaultSellingPrice: number;
  baseUnit: ProductBaseUnit;
  unitsPerPack: number | null;
  packLabel: string | null;
  containerCapacity: number | null;
  allowFractionalQty: boolean;
  hasPackHelper: boolean;
  createdAt: Date;
  updatedAt: Date;
  currentCost: number | null;
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListProductsQueryDto): Promise<ProductItem[]> {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      deletedAt: null,
    };

    if (query.isActive === 'true') {
      where.isActive = true;
    } else if (query.isActive === 'false') {
      where.isActive = false;
    }

    if (query.search?.trim()) {
      where.name = { contains: query.search.trim() };
    }

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    const costMap = await this.resolveCurrentCosts(
      tenantId,
      products.map((p) => p.id),
      endOfLocalTodayUtc(),
    );

    return products.map((p) => this.toItem(p, costMap.get(p.id) ?? null));
  }

  async findOne(id: string, tenantId: string): Promise<ProductItem> {
    const [product, currentCost] = await Promise.all([
      this.findActiveOrThrow(id, tenantId),
      this.resolveCurrentCost(tenantId, id, endOfLocalTodayUtc()),
    ]);
    return this.toItem(product, currentCost);
  }

  async create(tenantId: string, dto: CreateProductDto, actorId: string): Promise<ProductItem> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Product name is required');

    await this.assertNameUnique(tenantId, name);

    const pack = normalizePackFields({
      unitsPerPack: dto.unitsPerPack,
      packLabel: dto.packLabel,
    });
    const allowFractionalQty =
      dto.allowFractionalQty ??
      (dto.baseUnit === ProductBaseUnit.LTR || dto.baseUnit === ProductBaseUnit.KG);

    const product = await this.prisma.product.create({
      data: {
        tenantId,
        name,
        volume: dto.volume ?? null,
        unit: dto.unit?.trim() || defaultUnitLabel(dto.baseUnit),
        sku: dto.sku?.trim() || null,
        defaultSellingPrice: dto.defaultSellingPrice,
        baseUnit: dto.baseUnit as PrismaProductBaseUnit,
        unitsPerPack: pack.unitsPerPack,
        packLabel: pack.packLabel,
        containerCapacity: dto.containerCapacity ?? null,
        allowFractionalQty,
        isReturnable: dto.isReturnable ?? true,
        containerType: dto.containerType?.trim() || null,
        isActive: dto.isActive ?? true,
      },
    });

    let currentCost: number | null = null;
    if (dto.initialCostPerUnit !== undefined) {
      const [cost] = await Promise.all([
        this.prisma.productCostHistory.create({
          data: {
            tenantId,
            productId: product.id,
            costPerUnit: dto.initialCostPerUnit,
            effectiveFrom: startOfLocalTodayUtc(),
            notes: 'Initial cost',
            createdById: actorId,
          },
        }),
        this.audit.write({
          tenantId,
          actorId,
          module: 'products',
          action: 'CREATE',
          entityId: product.id,
          newValue: {
            name: product.name,
            baseUnit: dto.baseUnit,
            defaultSellingPrice: dto.defaultSellingPrice,
          },
        }),
      ]);
      currentCost = Number(cost.costPerUnit.toString());
    } else {
      await this.audit.write({
        tenantId,
        actorId,
        module: 'products',
        action: 'CREATE',
        entityId: product.id,
        newValue: {
          name: product.name,
          baseUnit: dto.baseUnit,
          defaultSellingPrice: dto.defaultSellingPrice,
        },
      });
    }

    return this.toItem(product, currentCost);
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateProductDto,
    actorId: string,
  ): Promise<ProductItem> {
    const existing = await this.findActiveOrThrow(id, tenantId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Product name is required');
      await this.assertNameUnique(tenantId, name, id);
    }

    const packTouched = dto.unitsPerPack !== undefined || dto.packLabel !== undefined;
    const pack = packTouched
      ? normalizePackFields({
          unitsPerPack: dto.unitsPerPack !== undefined ? dto.unitsPerPack : existing.unitsPerPack,
          packLabel: dto.packLabel !== undefined ? dto.packLabel : existing.packLabel,
        })
      : null;

    const nextBaseUnit = (dto.baseUnit ?? existing.baseUnit) as ProductBaseUnit;
    const allowFractionalQty =
      dto.allowFractionalQty !== undefined
        ? dto.allowFractionalQty
        : dto.baseUnit !== undefined
          ? nextBaseUnit === ProductBaseUnit.LTR || nextBaseUnit === ProductBaseUnit.KG
          : undefined;

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.volume !== undefined ? { volume: dto.volume } : {}),
        ...(dto.unit !== undefined
          ? { unit: dto.unit?.trim() || null }
          : dto.baseUnit !== undefined
            ? { unit: defaultUnitLabel(dto.baseUnit) }
            : {}),
        ...(dto.sku !== undefined ? { sku: dto.sku?.trim() || null } : {}),
        ...(dto.defaultSellingPrice !== undefined
          ? { defaultSellingPrice: dto.defaultSellingPrice }
          : {}),
        ...(dto.baseUnit !== undefined ? { baseUnit: dto.baseUnit as PrismaProductBaseUnit } : {}),
        ...(pack ? { unitsPerPack: pack.unitsPerPack, packLabel: pack.packLabel } : {}),
        ...(dto.containerCapacity !== undefined
          ? { containerCapacity: dto.containerCapacity }
          : {}),
        ...(allowFractionalQty !== undefined ? { allowFractionalQty } : {}),
        ...(dto.isReturnable !== undefined ? { isReturnable: dto.isReturnable } : {}),
        ...(dto.containerType !== undefined
          ? { containerType: dto.containerType?.trim() || null }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    const [, currentCost] = await Promise.all([
      this.audit.write({
        tenantId,
        actorId,
        module: 'products',
        action: 'UPDATE',
        entityId: id,
        oldValue: {
          name: existing.name,
          baseUnit: existing.baseUnit,
          defaultSellingPrice: decimalToNumber(existing.defaultSellingPrice),
          isActive: existing.isActive,
        },
        newValue: dto as unknown as Record<string, unknown>,
      }),
      this.resolveCurrentCost(tenantId, id, endOfLocalTodayUtc()),
    ]);

    return this.toItem(updated, currentCost);
  }

  async softDelete(id: string, tenantId: string, actorId: string): Promise<void> {
    const existing = await this.findActiveOrThrow(id, tenantId);

    await this.prisma.product.update({
      where: { id },
      data: {
        name: `${existing.name}_deleted_${Date.now()}`,
        isActive: false,
        deletedAt: new Date(),
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'products',
      action: 'DELETE',
      entityId: id,
      oldValue: { name: existing.name },
      newValue: { deletedAt: new Date().toISOString() },
    });
  }

  async listCosts(productId: string, tenantId: string): Promise<ProductCostItem[]> {
    const [, rows] = await Promise.all([
      this.findActiveOrThrow(productId, tenantId),
      this.prisma.productCostHistory.findMany({
        where: { tenantId, productId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    return rows.map((r) => this.toCostItem(r));
  }

  async addCost(
    productId: string,
    tenantId: string,
    dto: CreateProductCostDto,
    actorId: string,
  ): Promise<ProductCostItem> {
    await this.findActiveOrThrow(productId, tenantId);

    const effectiveFrom = dto.effectiveFrom
      ? parseCalendarDateUtc(dto.effectiveFrom, false)
      : startOfLocalTodayUtc();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom date');
    }

    const cost = await this.prisma.productCostHistory.create({
      data: {
        tenantId,
        productId,
        costPerUnit: dto.costPerUnit,
        effectiveFrom,
        notes: dto.notes?.trim() || null,
        createdById: actorId,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'products',
      action: 'UPDATE',
      entityId: productId,
      newValue: {
        costEntryId: cost.id,
        costPerUnit: dto.costPerUnit,
        effectiveFrom: effectiveFrom.toISOString(),
      },
    });

    return this.toCostItem(cost);
  }

  async currentCost(
    productId: string,
    tenantId: string,
    date?: string,
  ): Promise<{ productId: string; date: string; costPerUnit: number | null }> {
    const asOf = date ? parseCalendarDateUtc(date, true) : endOfLocalTodayUtc();
    if (Number.isNaN(asOf.getTime())) {
      throw new BadRequestException('Invalid date');
    }

    const [, costPerUnit] = await Promise.all([
      this.findActiveOrThrow(productId, tenantId),
      this.resolveCurrentCost(tenantId, productId, asOf),
    ]);

    return {
      productId,
      date: formatCalendarDateUtc(asOf),
      costPerUnit,
    };
  }

  private async findActiveOrThrow(id: string, tenantId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.product.findFirst({
      where: {
        tenantId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A product named "${name}" already exists`);
    }
  }

  private async resolveCurrentCost(
    tenantId: string,
    productId: string,
    asOf: Date,
  ): Promise<number | null> {
    const row = await this.prisma.productCostHistory.findFirst({
      where: {
        tenantId,
        productId,
        effectiveFrom: { lte: asOf },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { costPerUnit: true },
    });
    return row ? Number(row.costPerUnit.toString()) : null;
  }

  private async resolveCurrentCosts(
    tenantId: string,
    productIds: string[],
    asOf: Date,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (productIds.length === 0) return map;

    const rows = await this.prisma.productCostHistory.findMany({
      where: {
        tenantId,
        productId: { in: productIds },
        effectiveFrom: { lte: asOf },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { productId: true, costPerUnit: true },
    });

    for (const row of rows) {
      if (!map.has(row.productId)) {
        map.set(row.productId, Number(row.costPerUnit.toString()));
      }
    }
    return map;
  }

  private toItem(
    product: {
      id: string;
      tenantId: string;
      name: string;
      volume: Prisma.Decimal | null;
      unit: string | null;
      sku: string | null;
      isActive: boolean;
      isReturnable: boolean;
      containerType: string | null;
      defaultSellingPrice: Prisma.Decimal;
      baseUnit: PrismaProductBaseUnit;
      unitsPerPack: number | null;
      packLabel: string | null;
      containerCapacity: Prisma.Decimal | null;
      allowFractionalQty: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    currentCost: number | null,
  ): ProductItem {
    return {
      id: product.id,
      tenantId: product.tenantId,
      name: product.name,
      volume: decimalToNumber(product.volume),
      unit: product.unit,
      sku: product.sku,
      isActive: product.isActive,
      isReturnable: product.isReturnable,
      containerType: product.containerType,
      defaultSellingPrice: Number(product.defaultSellingPrice.toString()),
      baseUnit: product.baseUnit as ProductBaseUnit,
      unitsPerPack: product.unitsPerPack,
      packLabel: product.packLabel,
      containerCapacity: decimalToNumber(product.containerCapacity),
      allowFractionalQty: product.allowFractionalQty,
      hasPackHelper: product.unitsPerPack != null && product.unitsPerPack > 0,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      currentCost,
    };
  }

  private toCostItem(row: {
    id: string;
    tenantId: string;
    productId: string;
    costPerUnit: Prisma.Decimal;
    effectiveFrom: Date;
    notes: string | null;
    createdById: string | null;
    createdAt: Date;
  }): ProductCostItem {
    return {
      id: row.id,
      tenantId: row.tenantId,
      productId: row.productId,
      costPerUnit: Number(row.costPerUnit.toString()),
      effectiveFrom: row.effectiveFrom,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
    };
  }
}
