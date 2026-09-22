import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { VehicleStatus } from '../common/enums/vehicle.enum';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { ListVehiclesQueryDto } from './dto/list-vehicles-query.dto';

export type VehicleItem = {
  id: string;
  tenantId: string;
  name: string;
  plateNumber: string | null;
  type: string | null;
  status: VehicleStatus;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListVehiclesQueryDto): Promise<PaginatedData<VehicleItem>> {
    const { skip, take } = getPaginationParams(query);
    const where: {
      tenantId: string;
      deletedAt: null;
      status?: VehicleStatus;
      OR?: Array<Record<string, { contains: string }>>;
    } = {
      tenantId,
      deletedAt: null,
    };

    if (query.status) where.status = query.status;

    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { name: { contains: q } },
        { plateNumber: { contains: q } },
        { type: { contains: q } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.vehicle.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          tenantId: true,
          name: true,
          plateNumber: true,
          type: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.vehicle.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({ ...r, status: r.status as VehicleStatus })),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string): Promise<VehicleItem> {
    return this.findActiveOrThrow(id, tenantId);
  }

  async create(tenantId: string, dto: CreateVehicleDto, actorId: string): Promise<VehicleItem> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Vehicle name is required');
    await this.assertNameUnique(tenantId, name);

    const vehicle = await this.prisma.vehicle.create({
      data: {
        tenantId,
        name,
        plateNumber: dto.plateNumber ?? null,
        type: dto.type ?? null,
        status: dto.status ?? VehicleStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        plateNumber: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vehicles',
      action: 'CREATE',
      entityId: vehicle.id,
      newValue: { name: vehicle.name, plateNumber: vehicle.plateNumber },
    });

    return { ...vehicle, status: vehicle.status as VehicleStatus };
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateVehicleDto,
    actorId: string,
  ): Promise<VehicleItem> {
    const existing = await this.findActiveOrThrow(id, tenantId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Vehicle name is required');
      await this.assertNameUnique(tenantId, name, id);
    }

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.plateNumber !== undefined ? { plateNumber: dto.plateNumber } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        plateNumber: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vehicles',
      action: 'UPDATE',
      entityId: id,
      oldValue: {
        name: existing.name,
        status: existing.status,
        plateNumber: existing.plateNumber,
      },
      newValue: dto as unknown as Record<string, unknown>,
    });

    return { ...updated, status: updated.status as VehicleStatus };
  }

  async softDelete(id: string, tenantId: string, actorId: string): Promise<void> {
    const existing = await this.findActiveOrThrow(id, tenantId);
    const mangledName = `${existing.name}_deleted_${Date.now()}`;

    await this.prisma.vehicle.update({
      where: { id },
      data: {
        name: mangledName,
        status: VehicleStatus.INACTIVE,
        deletedAt: new Date(),
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vehicles',
      action: 'DELETE',
      entityId: id,
      oldValue: { name: existing.name },
      newValue: { deletedAt: new Date().toISOString() },
    });
  }

  private async findActiveOrThrow(id: string, tenantId: string): Promise<VehicleItem> {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        tenantId: true,
        name: true,
        plateNumber: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return { ...vehicle, status: vehicle.status as VehicleStatus };
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.vehicle.findFirst({
      where: {
        tenantId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A vehicle named "${name}" already exists`);
    }
  }
}
