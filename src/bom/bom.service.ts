import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertProductionEnabled } from '../common/helpers/production.helper';
import { CreateBomDto, ListBomsQueryDto, UpdateBomDto } from './dto/bom.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

/**
 * BOM / recipes. Never posts stock; never touches DeliveryRunStock.
 * assertProductionEnabled only — inventory + raw-materials required later for production complete.
 */
@Injectable()
export class BomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListBomsQueryDto) {
    await assertProductionEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.BomWhereInput = {
      tenantId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.isActive != null ? { isActive: query.isActive } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.bom.findMany({
        where,
        skip,
        take,
        orderBy: [{ productId: 'asc' }, { version: 'desc' }],
        include: {
          product: { select: { id: true, name: true, sku: true, isActive: true } },
          lines: {
            include: {
              rawMaterial: {
                select: { id: true, name: true, unit: true, sku: true, isActive: true },
              },
            },
            orderBy: { rawMaterialId: 'asc' },
          },
        },
      }),
      this.prisma.bom.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.mapDetail(r)),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const bom = await this.requireBom(tenantId, id);
    return this.mapDetail(bom);
  }

  async findActiveForProduct(productId: string, tenantId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    await this.requireProduct(tenantId, productId);

    const bom = await this.prisma.bom.findFirst({
      where: { tenantId, productId, isActive: true },
      include: {
        product: { select: { id: true, name: true, sku: true, isActive: true } },
        lines: {
          include: {
            rawMaterial: {
              select: { id: true, name: true, unit: true, sku: true, isActive: true },
            },
          },
          orderBy: { rawMaterialId: 'asc' },
        },
      },
    });

    return bom ? this.mapDetail(bom) : null;
  }

  async create(tenantId: string, dto: CreateBomDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    await this.requireProduct(tenantId, dto.productId);
    const lines = this.normalizeLines(dto.lines);
    await this.assertRawMaterials(
      tenantId,
      lines.map((l) => l.rawMaterialId),
    );

    const activate = dto.isActive !== false;
    if (activate && lines.length === 0) {
      throw new BadRequestException('Active BOM requires at least one line');
    }

    const maxVersion = await this.prisma.bom.aggregate({
      where: { tenantId, productId: dto.productId },
      _max: { version: true },
    });
    const version = (maxVersion._max.version ?? 0) + 1;

    const bom = await this.prisma.$transaction(async (tx) => {
      if (activate) {
        await tx.bom.updateMany({
          where: { tenantId, productId: dto.productId, isActive: true },
          data: { isActive: false },
        });
      }

      return tx.bom.create({
        data: {
          tenantId,
          productId: dto.productId,
          name: dto.name?.trim() || null,
          notes: dto.notes?.trim() || null,
          isActive: activate,
          version,
          lines: {
            create: lines.map((l) => ({
              tenantId,
              rawMaterialId: l.rawMaterialId,
              qtyPerOutputUnit: new Prisma.Decimal(l.qtyPerOutputUnit.toFixed(6)),
            })),
          },
        },
        include: {
          product: { select: { id: true, name: true, sku: true, isActive: true } },
          lines: {
            include: {
              rawMaterial: {
                select: { id: true, name: true, unit: true, sku: true, isActive: true },
              },
            },
            orderBy: { rawMaterialId: 'asc' },
          },
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'bom',
      action: 'CREATE',
      entityId: bom.id,
      newValue: {
        productId: bom.productId,
        version: bom.version,
        isActive: bom.isActive,
        lineCount: bom.lines.length,
      },
    });

    return this.mapDetail(bom);
  }

  async update(id: string, tenantId: string, dto: UpdateBomDto, actorId: string) {
    await assertProductionEnabled(this.prisma, tenantId);
    const existing = await this.requireBom(tenantId, id);

    const lines = dto.lines !== undefined ? this.normalizeLines(dto.lines) : undefined;
    if (lines) {
      await this.assertRawMaterials(
        tenantId,
        lines.map((l) => l.rawMaterialId),
      );
    }

    const nextActive = dto.isActive !== undefined ? dto.isActive : existing.isActive;
    const nextLineCount = lines ? lines.length : existing.lines.length;
    if (nextActive && nextLineCount < 1) {
      throw new BadRequestException('Active BOM requires at least one line');
    }

    const bom = await this.prisma.$transaction(async (tx) => {
      if (nextActive && !existing.isActive) {
        await tx.bom.updateMany({
          where: {
            tenantId,
            productId: existing.productId,
            isActive: true,
            NOT: { id },
          },
          data: { isActive: false },
        });
      }

      if (lines) {
        await tx.bomLine.deleteMany({ where: { bomId: id, tenantId } });
        await tx.bomLine.createMany({
          data: lines.map((l) => ({
            tenantId,
            bomId: id,
            rawMaterialId: l.rawMaterialId,
            qtyPerOutputUnit: new Prisma.Decimal(l.qtyPerOutputUnit.toFixed(6)),
          })),
        });
      }

      return tx.bom.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name?.trim() || null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        include: {
          product: { select: { id: true, name: true, sku: true, isActive: true } },
          lines: {
            include: {
              rawMaterial: {
                select: { id: true, name: true, unit: true, sku: true, isActive: true },
              },
            },
            orderBy: { rawMaterialId: 'asc' },
          },
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'bom',
      action: 'UPDATE',
      entityId: bom.id,
      oldValue: { isActive: existing.isActive, lineCount: existing.lines.length },
      newValue: { isActive: bom.isActive, lineCount: bom.lines.length },
    });

    return this.mapDetail(bom);
  }

  async deactivate(id: string, tenantId: string, actorId: string) {
    return this.update(id, tenantId, { isActive: false }, actorId);
  }

  private normalizeLines(lines: { rawMaterialId: string; qtyPerOutputUnit: number }[]) {
    const seen = new Set<string>();
    const normalized: { rawMaterialId: string; qtyPerOutputUnit: number }[] = [];

    for (const line of lines) {
      const rawMaterialId = line.rawMaterialId?.trim();
      if (!rawMaterialId) throw new BadRequestException('rawMaterialId required');
      if (seen.has(rawMaterialId)) {
        throw new BadRequestException('Duplicate raw material on BOM lines');
      }
      const qty = Number(line.qtyPerOutputUnit);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('qtyPerOutputUnit must be > 0');
      }
      seen.add(rawMaterialId);
      normalized.push({ rawMaterialId, qtyPerOutputUnit: qty });
    }

    if (normalized.length < 1) {
      throw new BadRequestException('At least one BOM line required');
    }
    return normalized;
  }

  private async assertRawMaterials(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.rawMaterial.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true, isActive: true, name: true },
    });
    if (rows.length !== unique.length) {
      throw new NotFoundException('One or more raw materials not found');
    }
    const inactive = rows.find((r) => !r.isActive);
    if (inactive) {
      throw new BadRequestException(`Raw material "${inactive.name}" is inactive`);
    }
  }

  private async requireProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive) throw new BadRequestException('Product is inactive');
    return product;
  }

  private async requireBom(tenantId: string, id: string) {
    const bom = await this.prisma.bom.findFirst({
      where: { id, tenantId },
      include: {
        product: { select: { id: true, name: true, sku: true, isActive: true } },
        lines: {
          include: {
            rawMaterial: {
              select: { id: true, name: true, unit: true, sku: true, isActive: true },
            },
          },
          orderBy: { rawMaterialId: 'asc' },
        },
      },
    });
    if (!bom) throw new NotFoundException('BOM not found');
    return bom;
  }

  private mapDetail(bom: {
    id: string;
    tenantId: string;
    productId: string;
    name: string | null;
    notes: string | null;
    isActive: boolean;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    product?: { id: string; name: string; sku: string | null; isActive: boolean };
    lines: Array<{
      id: string;
      rawMaterialId: string;
      qtyPerOutputUnit: Prisma.Decimal;
      rawMaterial?: {
        id: string;
        name: string;
        unit: string;
        sku: string | null;
        isActive: boolean;
      };
    }>;
  }) {
    return {
      id: bom.id,
      tenantId: bom.tenantId,
      productId: bom.productId,
      name: bom.name,
      notes: bom.notes,
      isActive: bom.isActive,
      version: bom.version,
      createdAt: bom.createdAt,
      updatedAt: bom.updatedAt,
      product: bom.product,
      lines: bom.lines.map((l) => ({
        id: l.id,
        rawMaterialId: l.rawMaterialId,
        qtyPerOutputUnit: decimalToNumber(l.qtyPerOutputUnit),
        rawMaterial: l.rawMaterial,
      })),
    };
  }
}
