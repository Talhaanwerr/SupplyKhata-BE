import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { assertVendorsEnabled } from '../common/helpers/vendors.helper';
import { isVendorBillsEnabled } from '../common/helpers/vendor-bills.helper';
import { VendorBillsService } from '../vendor-bills/vendor-bills.service';
import { CreateVendorDto, UpdateVendorDto } from './dto/vendor.dto';
import { ListVendorsQueryDto } from './dto/list-vendors-query.dto';
import { todayYmdInTimeZone } from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';

function mapVendor(v: {
  id: string;
  tenantId: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: v.id,
    tenantId: v.tenantId,
    name: v.name,
    phone: v.phone,
    address: v.address,
    notes: v.notes,
    isActive: v.isActive,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly vendorBills: VendorBillsService,
  ) {}

  async list(tenantId: string, query: ListVendorsQueryDto) {
    await assertVendorsEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.VendorWhereInput = {
      tenantId,
      ...(query.isActive != null ? { isActive: query.isActive } : {}),
      ...(query.search?.trim()
        ? {
            OR: [
              { name: { contains: query.search.trim() } },
              { phone: { contains: query.search.trim() } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.vendor.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
      }),
      this.prisma.vendor.count({ where }),
    ]);

    return {
      items: rows.map(mapVendor),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertVendorsEnabled(this.prisma, tenantId);
    const vendor = await this.requireVendor(tenantId, id);

    const billsOn = await isVendorBillsEnabled(this.prisma, tenantId);
    if (!billsOn) {
      return {
        ...mapVendor(vendor),
        openPayables: {
          total: 0,
          billedTotal: 0,
          paidTotal: 0,
          note: 'Vendor bills disabled — enable vendor-bills for live payables.',
        },
      };
    }

    const summary = await this.vendorBills.payablesSummary(tenantId, id);
    return {
      ...mapVendor(vendor),
      openPayables: {
        total: summary.openTotal,
        billedTotal: summary.billedTotal,
        paidTotal: summary.paidTotal,
        note:
          summary.openTotal === 0
            ? 'No open payables.'
            : 'Outstanding unpaid / partially paid bills.',
      },
    };
  }

  async create(tenantId: string, dto: CreateVendorDto, actorId: string) {
    await assertVendorsEnabled(this.prisma, tenantId);

    const openingPayables =
      dto.openingPayables != null && Number.isFinite(dto.openingPayables)
        ? Number(dto.openingPayables)
        : 0;

    const vendor = await this.prisma.vendor.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        phone: dto.phone?.trim() || null,
        address: dto.address?.trim() || null,
        notes: dto.notes?.trim() || null,
        isActive: dto.isActive ?? true,
      },
    });

    // Opening payable → unpaid opening bill (counts in openPayablesTotal).
    if (openingPayables > 0 && (await isVendorBillsEnabled(this.prisma, tenantId))) {
      const today = todayYmdInTimeZone(await getTenantTimezone(this.prisma, tenantId));
      await this.vendorBills.create(
        tenantId,
        {
          vendorId: vendor.id,
          billDate: today,
          notes: 'Opening payable',
          lines: [
            {
              description: 'Opening payable',
              qty: 1,
              unitCost: openingPayables,
            },
          ],
        },
        actorId,
      );
    }

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendors',
      action: 'CREATE',
      entityId: vendor.id,
      newValue: {
        name: vendor.name,
        phone: vendor.phone,
        isActive: vendor.isActive,
        openingPayables: openingPayables > 0 ? openingPayables : undefined,
      },
    });

    return mapVendor(vendor);
  }

  async update(id: string, tenantId: string, dto: UpdateVendorDto, actorId: string) {
    await assertVendorsEnabled(this.prisma, tenantId);
    const existing = await this.requireVendor(tenantId, id);

    const openingPayables =
      dto.openingPayables != null && Number.isFinite(dto.openingPayables)
        ? Number(dto.openingPayables)
        : 0;

    const updated = await this.prisma.vendor.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.address !== undefined ? { address: dto.address?.trim() || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    if (openingPayables > 0 && (await isVendorBillsEnabled(this.prisma, tenantId))) {
      const today = todayYmdInTimeZone(await getTenantTimezone(this.prisma, tenantId));
      await this.vendorBills.create(
        tenantId,
        {
          vendorId: id,
          billDate: today,
          notes: 'Opening payable',
          lines: [
            {
              description: 'Opening payable',
              qty: 1,
              unitCost: openingPayables,
            },
          ],
        },
        actorId,
      );
    }

    const action =
      dto.isActive === false && existing.isActive
        ? 'DEACTIVATE'
        : dto.isActive === true && !existing.isActive
          ? 'ACTIVATE'
          : 'UPDATE';

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendors',
      action,
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: {
        name: updated.name,
        isActive: updated.isActive,
        openingPayables: openingPayables > 0 ? openingPayables : undefined,
      },
    });

    return mapVendor(updated);
  }

  private async requireVendor(tenantId: string, id: string) {
    const vendor = await this.prisma.vendor.findFirst({ where: { id, tenantId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }
}
