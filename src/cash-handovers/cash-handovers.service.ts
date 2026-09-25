import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { CreateCashHandoverDto } from './dto/create-cash-handover.dto';
import { UpdateCashHandoverDto } from './dto/update-cash-handover.dto';
import { ListCashHandoversQueryDto } from './dto/list-cash-handovers-query.dto';

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

const handoverInclude = {
  rider: { select: { id: true, firstName: true, lastName: true, email: true } },
  receivedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  deliveryRun: { select: { id: true, date: true, status: true } },
} as const;

@Injectable()
export class CashHandoversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreateCashHandoverDto, actorId: string) {
    await this.assertRider(tenantId, dto.riderId);
    await this.assertTenantMember(tenantId, dto.receivedById, 'receivedBy');
    if (dto.deliveryRunId) {
      await this.assertDeliveryRun(tenantId, dto.deliveryRunId);
    }

    const handover = await this.prisma.cashHandover.create({
      data: {
        tenantId,
        riderId: dto.riderId,
        receivedById: dto.receivedById,
        amount: new Prisma.Decimal(dto.amount),
        handoverDate: parseDate(dto.handoverDate),
        reference: dto.reference ?? null,
        notes: dto.notes?.trim() || null,
        deliveryRunId: dto.deliveryRunId || null,
      },
      include: handoverInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'handovers',
      action: 'CREATE',
      entityId: handover.id,
      newValue: {
        riderId: handover.riderId,
        receivedById: handover.receivedById,
        amount: decimalToNumber(handover.amount),
        handoverDate: handover.handoverDate.toISOString(),
      },
    });

    return this.toDetail(handover);
  }

  async list(
    tenantId: string,
    query: ListCashHandoversQueryDto,
  ): Promise<PaginatedData<ReturnType<CashHandoversService['toDetail']>>> {
    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(tenantId, query);

    const [rows, total] = await Promise.all([
      this.prisma.cashHandover.findMany({
        where,
        skip,
        take,
        orderBy: { handoverDate: 'desc' },
        include: handoverInclude,
      }),
      this.prisma.cashHandover.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toDetail(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    const handover = await this.prisma.cashHandover.findFirst({
      where: { id, tenantId },
      include: handoverInclude,
    });
    if (!handover) throw new NotFoundException('Cash handover not found');
    return this.toDetail(handover);
  }

  async update(id: string, tenantId: string, dto: UpdateCashHandoverDto, actorId: string) {
    const existing = await this.prisma.cashHandover.findFirst({
      where: { id, tenantId },
      include: handoverInclude,
    });
    if (!existing) throw new NotFoundException('Cash handover not found');

    const nextRiderId = dto.riderId ?? existing.riderId;
    const nextReceivedById = dto.receivedById ?? existing.receivedById;
    const nextDeliveryRunId =
      dto.deliveryRunId !== undefined ? dto.deliveryRunId || null : existing.deliveryRunId;

    if (dto.riderId) await this.assertRider(tenantId, dto.riderId);
    if (dto.receivedById) {
      await this.assertTenantMember(tenantId, dto.receivedById, 'receivedBy');
    }
    if (dto.deliveryRunId) {
      await this.assertDeliveryRun(tenantId, dto.deliveryRunId);
    }

    const oldValue = {
      riderId: existing.riderId,
      receivedById: existing.receivedById,
      amount: decimalToNumber(existing.amount),
      handoverDate: existing.handoverDate.toISOString(),
      reference: existing.reference,
      notes: existing.notes,
      deliveryRunId: existing.deliveryRunId,
    };

    const handover = await this.prisma.cashHandover.update({
      where: { id },
      data: {
        riderId: nextRiderId,
        receivedById: nextReceivedById,
        ...(dto.amount !== undefined ? { amount: new Prisma.Decimal(dto.amount) } : {}),
        ...(dto.handoverDate !== undefined ? { handoverDate: parseDate(dto.handoverDate) } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        deliveryRunId: nextDeliveryRunId,
      },
      include: handoverInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'handovers',
      action: 'UPDATE',
      entityId: id,
      oldValue,
      newValue: {
        riderId: handover.riderId,
        receivedById: handover.receivedById,
        amount: decimalToNumber(handover.amount),
        handoverDate: handover.handoverDate.toISOString(),
        reference: handover.reference,
        notes: handover.notes,
        deliveryRunId: handover.deliveryRunId,
      },
    });

    return this.toDetail(handover);
  }

  async remove(id: string, tenantId: string, actorId: string) {
    const existing = await this.prisma.cashHandover.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException('Cash handover not found');

    await this.prisma.cashHandover.delete({ where: { id } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'handovers',
      action: 'DELETE',
      entityId: id,
      oldValue: {
        riderId: existing.riderId,
        receivedById: existing.receivedById,
        amount: decimalToNumber(existing.amount),
        handoverDate: existing.handoverDate.toISOString(),
      },
    });
  }

  async riderCashBalance(tenantId: string, riderId: string) {
    await this.assertRider(tenantId, riderId);

    const [cashAgg, expenseAgg, handoverAgg] = await Promise.all([
      this.prisma.delivery.aggregate({
        where: {
          tenantId,
          deliveryRun: { riderId },
        },
        _sum: { cashReceived: true },
      }),
      this.prisma.expense.aggregate({
        where: {
          tenantId,
          staffId: riderId,
          isPaidByRider: true,
        },
        _sum: { amount: true },
      }),
      this.prisma.cashHandover.aggregate({
        where: { tenantId, riderId },
        _sum: { amount: true },
      }),
    ]);

    const cashCollected = decimalToNumber(cashAgg._sum.cashReceived);
    const riderPaidExpenses = decimalToNumber(expenseAgg._sum.amount);
    const cashHandedOver = decimalToNumber(handoverAgg._sum.amount);
    const currentBalance = roundMoney(cashCollected - riderPaidExpenses - cashHandedOver);

    return {
      cashCollected: roundMoney(cashCollected),
      riderPaidExpenses: roundMoney(riderPaidExpenses),
      cashHandedOver: roundMoney(cashHandedOver),
      currentBalance,
    };
  }

  private buildWhere(
    tenantId: string,
    query: ListCashHandoversQueryDto,
  ): Prisma.CashHandoverWhereInput {
    const where: Prisma.CashHandoverWhereInput = { tenantId };
    if (query.riderId) where.riderId = query.riderId;
    if (query.dateFrom || query.dateTo) {
      where.handoverDate = {};
      if (query.dateFrom) where.handoverDate.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.handoverDate.lte = endOfDay(query.dateTo);
    }
    return where;
  }

  private async assertRider(tenantId: string, riderId: string) {
    const rider = await this.prisma.user.findFirst({
      where: {
        id: riderId,
        deletedAt: null,
        memberships: { some: { tenantId, status: 'ACTIVE' } },
        roles: { some: { tenantId, role: { slug: 'rider' } } },
      },
      select: { id: true },
    });
    if (!rider) throw new BadRequestException('Rider must be an active rider in this workspace');
  }

  private async assertTenantMember(tenantId: string, userId: string, field: string) {
    const member = await this.prisma.tenantMember.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) {
      throw new BadRequestException(`${field} must be an active member of this workspace`);
    }
  }

  private async assertDeliveryRun(tenantId: string, deliveryRunId: string) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id: deliveryRunId, tenantId },
      select: { id: true },
    });
    if (!run) throw new BadRequestException('Delivery run not found in this workspace');
  }

  private toDetail(row: {
    id: string;
    tenantId: string;
    riderId: string;
    receivedById: string;
    amount: DecimalLike;
    handoverDate: Date;
    reference: string | null;
    notes: string | null;
    deliveryRunId: string | null;
    createdAt: Date;
    updatedAt: Date;
    rider: { id: string; firstName: string; lastName: string; email: string };
    receivedBy: { id: string; firstName: string; lastName: string; email: string };
    deliveryRun: { id: string; date: Date; status: string } | null;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      riderId: row.riderId,
      receivedById: row.receivedById,
      amount: decimalToNumber(row.amount),
      handoverDate: row.handoverDate,
      reference: row.reference,
      notes: row.notes,
      deliveryRunId: row.deliveryRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rider: row.rider,
      receivedBy: row.receivedBy,
      deliveryRun: row.deliveryRun,
    };
  }
}
