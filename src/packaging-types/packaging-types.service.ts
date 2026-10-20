import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { assertReturnableContainersEnabled } from '../common/helpers/returnable-containers.helper';
import { CreatePackagingTypeDto } from './dto/create-packaging-type.dto';
import { UpdatePackagingTypeDto } from './dto/update-packaging-type.dto';
import { ListPackagingTypesQueryDto } from './dto/list-packaging-types-query.dto';

export type PackagingTypeItem = {
  id: string;
  tenantId: string;
  name: string;
  capacity: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

@Injectable()
export class PackagingTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListPackagingTypesQueryDto): Promise<PackagingTypeItem[]> {
    await assertReturnableContainersEnabled(this.prisma, tenantId);

    const where: Prisma.PackagingTypeWhereInput = {
      tenantId,
      deletedAt: null,
    };

    if (!query.includeInactive) {
      where.isActive = true;
    }

    if (query.search?.trim()) {
      where.name = { contains: query.search.trim() };
    }

    const rows = await this.prisma.packagingType.findMany({
      where,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        tenantId: true,
        name: true,
        capacity: true,
        notes: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => this.toItem(row));
  }

  async create(
    tenantId: string,
    dto: CreatePackagingTypeDto,
    actorId: string,
  ): Promise<PackagingTypeItem> {
    await assertReturnableContainersEnabled(this.prisma, tenantId);

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Packaging type name is required');

    await this.assertNameUnique(tenantId, name);

    const created = await this.prisma.packagingType.create({
      data: {
        tenantId,
        name,
        capacity: dto.capacity ?? null,
        notes: dto.notes?.trim() || null,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        capacity: true,
        notes: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'packaging-types',
      action: 'CREATE',
      entityId: created.id,
      newValue: { name: created.name, capacity: decimalToNumber(created.capacity) },
    });

    return this.toItem(created);
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdatePackagingTypeDto,
    actorId: string,
  ): Promise<PackagingTypeItem> {
    await assertReturnableContainersEnabled(this.prisma, tenantId);
    const existing = await this.findActiveOrThrow(id, tenantId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Packaging type name is required');
      await this.assertNameUnique(tenantId, name, id);
    }

    // Deactivate instead of hard delete when referenced — soft path via isActive false.
    if (dto.isActive === false) {
      // Allowed even when products/movements reference the type.
    }

    const updated = await this.prisma.packagingType.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        capacity: true,
        notes: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'packaging-types',
      action: 'UPDATE',
      entityId: id,
      oldValue: {
        name: existing.name,
        capacity: decimalToNumber(existing.capacity),
        isActive: existing.isActive,
      },
      newValue: dto as unknown as Record<string, unknown>,
    });

    return this.toItem(updated);
  }

  private toItem(row: {
    id: string;
    tenantId: string;
    name: string;
    capacity: Prisma.Decimal | number | null;
    notes: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): PackagingTypeItem {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      capacity: decimalToNumber(row.capacity),
      notes: row.notes,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findActiveOrThrow(id: string, tenantId: string) {
    const row = await this.prisma.packagingType.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Packaging type not found');
    return row;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.packagingType.findFirst({
      where: {
        tenantId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A packaging type named "${name}" already exists`);
    }
  }
}
