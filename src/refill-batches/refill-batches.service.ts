import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { CreateRefillBatchDto } from './dto/create-refill-batch.dto';
import { UpdateRefillBatchDto } from './dto/update-refill-batch.dto';
import { ListRefillBatchesQueryDto } from './dto/list-refill-batches-query.dto';

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
  const d = parseDate(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

const batchInclude = {
  product: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  loads: { select: { quantityLoaded: true } },
} as const;

@Injectable()
export class RefillBatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreateRefillBatchDto, actorId: string) {
    await this.assertProduct(tenantId, dto.productId);

    const date = parseDate(dto.date);
    const costPerUnit = new Prisma.Decimal(dto.costPerUnit);
    const totalCost = new Prisma.Decimal(roundMoney(dto.cansFilledCount * dto.costPerUnit));

    // Intentionally does NOT touch ProductCostHistory — batch cost is plant-fill COGS only.
    const batch = await this.prisma.refillBatch.create({
      data: {
        tenantId,
        productId: dto.productId,
        date,
        cansFilledCount: dto.cansFilledCount,
        costPerUnit,
        totalCost,
        notes: dto.notes?.trim() || null,
        createdById: actorId,
      },
      include: batchInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'refill',
      action: 'CREATE',
      entityId: batch.id,
      newValue: {
        productId: batch.productId,
        cansFilledCount: batch.cansFilledCount,
        costPerUnit: decimalToNumber(batch.costPerUnit),
        totalCost: decimalToNumber(batch.totalCost),
        date: batch.date.toISOString(),
      },
    });

    return this.toDetail(batch);
  }

  async list(
    tenantId: string,
    query: ListRefillBatchesQueryDto,
  ): Promise<PaginatedData<ReturnType<RefillBatchesService['toDetail']>>> {
    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(tenantId, query);

    const [rows, total] = await Promise.all([
      this.prisma.refillBatch.findMany({
        where,
        skip,
        take,
        orderBy: { date: 'desc' },
        include: batchInclude,
      }),
      this.prisma.refillBatch.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toDetail(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async available(tenantId: string, productId?: string) {
    const where: Prisma.RefillBatchWhereInput = { tenantId };
    if (productId) where.productId = productId;

    const rows = await this.prisma.refillBatch.findMany({
      where,
      orderBy: { date: 'asc' },
      include: batchInclude,
    });

    return rows.map((row) => this.toDetail(row)).filter((row) => row.remainingCount > 0);
  }

  async findOne(id: string, tenantId: string) {
    const batch = await this.prisma.refillBatch.findFirst({
      where: { id, tenantId },
      include: batchInclude,
    });
    if (!batch) throw new NotFoundException('Refill batch not found');
    return this.toDetail(batch);
  }

  async update(id: string, tenantId: string, dto: UpdateRefillBatchDto, actorId: string) {
    const existing = await this.prisma.refillBatch.findFirst({
      where: { id, tenantId },
      include: batchInclude,
    });
    if (!existing) throw new NotFoundException('Refill batch not found');

    if (dto.productId && dto.productId !== existing.productId) {
      await this.assertProduct(tenantId, dto.productId);
    }

    const loadedSum = this.loadedSum(existing.loads);
    const nextCans = dto.cansFilledCount ?? existing.cansFilledCount;
    if (nextCans < loadedSum) {
      throw new BadRequestException(
        `Cannot reduce cans filled below already loaded quantity (${loadedSum})`,
      );
    }

    const nextCostPerUnit =
      dto.costPerUnit !== undefined ? new Prisma.Decimal(dto.costPerUnit) : existing.costPerUnit;
    const nextCostNum =
      dto.costPerUnit !== undefined ? dto.costPerUnit : decimalToNumber(existing.costPerUnit);
    const totalCost = new Prisma.Decimal(roundMoney(nextCans * nextCostNum));

    const oldValue = {
      productId: existing.productId,
      cansFilledCount: existing.cansFilledCount,
      costPerUnit: decimalToNumber(existing.costPerUnit),
      totalCost: decimalToNumber(existing.totalCost),
      date: existing.date.toISOString(),
      notes: existing.notes,
    };

    // Intentionally does NOT touch ProductCostHistory.
    const batch = await this.prisma.refillBatch.update({
      where: { id },
      data: {
        ...(dto.productId !== undefined ? { productId: dto.productId } : {}),
        ...(dto.date !== undefined ? { date: parseDate(dto.date) } : {}),
        ...(dto.cansFilledCount !== undefined ? { cansFilledCount: dto.cansFilledCount } : {}),
        ...(dto.costPerUnit !== undefined ? { costPerUnit: nextCostPerUnit } : {}),
        totalCost,
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
      },
      include: batchInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'refill',
      action: 'UPDATE',
      entityId: id,
      oldValue,
      newValue: {
        productId: batch.productId,
        cansFilledCount: batch.cansFilledCount,
        costPerUnit: decimalToNumber(batch.costPerUnit),
        totalCost: decimalToNumber(batch.totalCost),
        date: batch.date.toISOString(),
        notes: batch.notes,
      },
    });

    return this.toDetail(batch);
  }

  async remove(id: string, tenantId: string, actorId: string) {
    const existing = await this.prisma.refillBatch.findFirst({
      where: { id, tenantId },
      include: { loads: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Refill batch not found');

    if (existing.loads.length > 0) {
      throw new BadRequestException('Cannot delete a refill batch that has been loaded onto runs');
    }

    await this.prisma.refillBatch.delete({ where: { id } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'refill',
      action: 'DELETE',
      entityId: id,
      oldValue: {
        productId: existing.productId,
        cansFilledCount: existing.cansFilledCount,
        costPerUnit: decimalToNumber(existing.costPerUnit),
        totalCost: decimalToNumber(existing.totalCost),
        date: existing.date.toISOString(),
      },
    });
  }

  private buildWhere(
    tenantId: string,
    query: ListRefillBatchesQueryDto,
  ): Prisma.RefillBatchWhereInput {
    const where: Prisma.RefillBatchWhereInput = { tenantId };
    if (query.productId) where.productId = query.productId;
    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.date.lte = endOfDay(query.dateTo);
    }
    return where;
  }

  private async assertProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
  }

  private loadedSum(loads: Array<{ quantityLoaded: number }>): number {
    return loads.reduce((sum, load) => sum + load.quantityLoaded, 0);
  }

  private toDetail(row: {
    id: string;
    tenantId: string;
    productId: string;
    date: Date;
    cansFilledCount: number;
    costPerUnit: DecimalLike;
    totalCost: DecimalLike;
    notes: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    product: { id: string; name: string };
    createdBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
    loads: Array<{ quantityLoaded: number }>;
  }) {
    const loaded = this.loadedSum(row.loads);
    return {
      id: row.id,
      tenantId: row.tenantId,
      productId: row.productId,
      date: row.date,
      cansFilledCount: row.cansFilledCount,
      costPerUnit: decimalToNumber(row.costPerUnit),
      totalCost: decimalToNumber(row.totalCost),
      remainingCount: row.cansFilledCount - loaded,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      product: row.product,
      createdBy: row.createdBy,
    };
  }
}
