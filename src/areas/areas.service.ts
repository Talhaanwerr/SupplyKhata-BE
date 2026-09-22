import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateAreaDto } from './dto/create-area.dto';
import { UpdateAreaDto } from './dto/update-area.dto';
import { ListAreasQueryDto } from './dto/list-areas-query.dto';

export type AreaItem = {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class AreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListAreasQueryDto): Promise<AreaItem[]> {
    const where: Prisma.AreaWhereInput = {
      tenantId,
      deletedAt: null,
    };

    if (!query.includeInactive) {
      where.isActive = true;
    }

    if (query.search?.trim()) {
      where.name = { contains: query.search.trim() };
    }

    return this.prisma.area.findMany({
      where,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        tenantId: true,
        name: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async create(tenantId: string, dto: CreateAreaDto, actorId: string): Promise<AreaItem> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Area name is required');

    await this.assertNameUnique(tenantId, name);

    const area = await this.prisma.area.create({
      data: { tenantId, name },
      select: {
        id: true,
        tenantId: true,
        name: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'areas',
      action: 'CREATE',
      entityId: area.id,
      newValue: { name: area.name },
    });

    return area;
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateAreaDto,
    actorId: string,
  ): Promise<AreaItem> {
    const existing = await this.findActiveOrThrow(id, tenantId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Area name is required');
      await this.assertNameUnique(tenantId, name, id);
    }

    const updated = await this.prisma.area.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'areas',
      action: 'UPDATE',
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: dto as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async softDelete(id: string, tenantId: string, actorId: string): Promise<void> {
    const existing = await this.findActiveOrThrow(id, tenantId);

    // Free DB unique [tenantId, name] so the name can be reused (MySQL has no partial indexes).
    const mangledName = `${existing.name}_deleted_${Date.now()}`;

    await this.prisma.area.update({
      where: { id },
      data: {
        name: mangledName,
        isActive: false,
        deletedAt: new Date(),
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'areas',
      action: 'DELETE',
      entityId: id,
      oldValue: { name: existing.name },
      newValue: { deletedAt: new Date().toISOString() },
    });
  }

  private async findActiveOrThrow(id: string, tenantId: string) {
    const area = await this.prisma.area.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!area) throw new NotFoundException('Area not found');
    return area;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.area.findFirst({
      where: {
        tenantId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`An area named "${name}" already exists`);
    }
  }
}
