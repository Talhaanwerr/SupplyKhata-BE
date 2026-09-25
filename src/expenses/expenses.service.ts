import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod as PrismaPaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginationMeta } from '../common/types/api-response.type';
import { PaymentMethod } from '../common/enums/delivery.enum';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ListExpensesQueryDto } from './dto/list-expenses-query.dto';

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

const expenseInclude = {
  vehicle: { select: { id: true, name: true, plateNumber: true } },
  deliveryRun: { select: { id: true, date: true, status: true } },
  staff: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreateExpenseDto, actorId: string) {
    const isPaidByRider = dto.isPaidByRider === true;
    const staffId = dto.staffId ?? null;
    this.assertRiderPaidRequiresStaff(isPaidByRider, staffId);

    await this.assertRelations(tenantId, {
      vehicleId: dto.vehicleId ?? null,
      deliveryRunId: dto.deliveryRunId ?? null,
      staffId,
    });

    const expense = await this.prisma.expense.create({
      data: {
        tenantId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        date: parseDate(dto.date),
        amount: new Prisma.Decimal(dto.amount),
        vehicleId: dto.vehicleId || null,
        deliveryRunId: dto.deliveryRunId || null,
        staffId,
        paymentMethod: dto.paymentMethod as PrismaPaymentMethod,
        reference: dto.reference ?? null,
        isPaidByRider,
      },
      include: expenseInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'expenses',
      action: 'CREATE',
      entityId: expense.id,
      newValue: {
        title: expense.title,
        amount: decimalToNumber(expense.amount),
        date: expense.date.toISOString(),
        isPaidByRider: expense.isPaidByRider,
        staffId: expense.staffId,
      },
    });

    return this.toDetail(expense);
  }

  async list(
    tenantId: string,
    query: ListExpensesQueryDto,
  ): Promise<{
    items: ReturnType<ExpensesService['toDetail']>[];
    meta: PaginationMeta;
    filterTotal: number;
  }> {
    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(tenantId, query);

    const [rows, total, sumAgg] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        skip,
        take,
        orderBy: { date: 'desc' },
        include: expenseInclude,
      }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
      items: rows.map((row) => this.toDetail(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
      filterTotal: decimalToNumber(sumAgg._sum.amount),
    };
  }

  async findOne(id: string, tenantId: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, tenantId },
      include: expenseInclude,
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return this.toDetail(expense);
  }

  async update(id: string, tenantId: string, dto: UpdateExpenseDto, actorId: string) {
    const existing = await this.prisma.expense.findFirst({
      where: { id, tenantId },
      include: expenseInclude,
    });
    if (!existing) throw new NotFoundException('Expense not found');

    const nextIsPaidByRider =
      dto.isPaidByRider !== undefined ? dto.isPaidByRider === true : existing.isPaidByRider;
    const nextStaffId = dto.staffId !== undefined ? dto.staffId || null : existing.staffId;
    this.assertRiderPaidRequiresStaff(nextIsPaidByRider, nextStaffId);

    await this.assertRelations(tenantId, {
      vehicleId: dto.vehicleId !== undefined ? dto.vehicleId || null : existing.vehicleId,
      deliveryRunId:
        dto.deliveryRunId !== undefined ? dto.deliveryRunId || null : existing.deliveryRunId,
      staffId: nextStaffId,
    });

    const oldValue = {
      title: existing.title,
      amount: decimalToNumber(existing.amount),
      date: existing.date.toISOString(),
      isPaidByRider: existing.isPaidByRider,
      staffId: existing.staffId,
      vehicleId: existing.vehicleId,
      deliveryRunId: existing.deliveryRunId,
      paymentMethod: existing.paymentMethod,
      reference: existing.reference,
      description: existing.description,
    };

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.date !== undefined ? { date: parseDate(dto.date) } : {}),
        ...(dto.amount !== undefined ? { amount: new Prisma.Decimal(dto.amount) } : {}),
        ...(dto.vehicleId !== undefined ? { vehicleId: dto.vehicleId || null } : {}),
        ...(dto.deliveryRunId !== undefined ? { deliveryRunId: dto.deliveryRunId || null } : {}),
        ...(dto.staffId !== undefined ? { staffId: dto.staffId || null } : {}),
        ...(dto.paymentMethod !== undefined
          ? { paymentMethod: dto.paymentMethod as PrismaPaymentMethod }
          : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
        ...(dto.isPaidByRider !== undefined ? { isPaidByRider: nextIsPaidByRider } : {}),
      },
      include: expenseInclude,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'expenses',
      action: 'UPDATE',
      entityId: id,
      oldValue,
      newValue: {
        title: expense.title,
        amount: decimalToNumber(expense.amount),
        date: expense.date.toISOString(),
        isPaidByRider: expense.isPaidByRider,
        staffId: expense.staffId,
        vehicleId: expense.vehicleId,
        deliveryRunId: expense.deliveryRunId,
        paymentMethod: expense.paymentMethod,
        reference: expense.reference,
        description: expense.description,
      },
    });

    return this.toDetail(expense);
  }

  async remove(id: string, tenantId: string, actorId: string) {
    const existing = await this.prisma.expense.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException('Expense not found');

    await this.prisma.expense.delete({ where: { id } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'expenses',
      action: 'DELETE',
      entityId: id,
      oldValue: {
        title: existing.title,
        amount: decimalToNumber(existing.amount),
        date: existing.date.toISOString(),
        isPaidByRider: existing.isPaidByRider,
        staffId: existing.staffId,
      },
    });
  }

  private buildWhere(tenantId: string, query: ListExpensesQueryDto): Prisma.ExpenseWhereInput {
    const where: Prisma.ExpenseWhereInput = { tenantId };

    if (query.staffId) where.staffId = query.staffId;
    if (query.vehicleId) where.vehicleId = query.vehicleId;
    if (query.isPaidByRider !== undefined) where.isPaidByRider = query.isPaidByRider;
    if (query.search?.trim()) {
      where.title = { contains: query.search.trim() };
    }
    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.date.lte = endOfDay(query.dateTo);
    }

    return where;
  }

  private assertRiderPaidRequiresStaff(isPaidByRider: boolean, staffId: string | null) {
    if (isPaidByRider && !staffId) {
      throw new BadRequestException('staffId (rider) is required when isPaidByRider is true');
    }
  }

  private async assertRelations(
    tenantId: string,
    refs: {
      vehicleId: string | null;
      deliveryRunId: string | null;
      staffId: string | null;
    },
  ) {
    if (refs.vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { id: refs.vehicleId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!vehicle) throw new BadRequestException('Vehicle not found in this workspace');
    }

    if (refs.deliveryRunId) {
      const run = await this.prisma.deliveryRun.findFirst({
        where: { id: refs.deliveryRunId, tenantId },
        select: { id: true },
      });
      if (!run) throw new BadRequestException('Delivery run not found in this workspace');
    }

    if (refs.staffId) {
      const member = await this.prisma.tenantMember.findFirst({
        where: { tenantId, userId: refs.staffId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!member)
        throw new BadRequestException('Staff must be an active member of this workspace');
    }
  }

  private toDetail(row: {
    id: string;
    tenantId: string;
    title: string;
    description: string | null;
    date: Date;
    amount: DecimalLike;
    vehicleId: string | null;
    deliveryRunId: string | null;
    staffId: string | null;
    paymentMethod: PrismaPaymentMethod;
    reference: string | null;
    isPaidByRider: boolean;
    createdAt: Date;
    updatedAt: Date;
    vehicle: { id: string; name: string; plateNumber: string | null } | null;
    deliveryRun: { id: string; date: Date; status: string } | null;
    staff: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      title: row.title,
      description: row.description,
      date: row.date,
      amount: decimalToNumber(row.amount),
      vehicleId: row.vehicleId,
      deliveryRunId: row.deliveryRunId,
      staffId: row.staffId,
      paymentMethod: row.paymentMethod as PaymentMethod,
      reference: row.reference,
      isPaidByRider: row.isPaidByRider,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      vehicle: row.vehicle,
      deliveryRun: row.deliveryRun,
      staff: row.staff,
    };
  }
}
