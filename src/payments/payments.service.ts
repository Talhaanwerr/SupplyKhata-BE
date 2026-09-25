import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerEntryType as PrismaLedgerEntryType,
  PaymentMethod as PrismaPaymentMethod,
  PaymentCycle as PrismaPaymentCycle,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { PaymentMethod } from '../common/enums/delivery.enum';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { lastDueDate, nextDueDate, sameCalendarDay, startOfDay } from './billing-due.helpers';
import {
  clearFulfilledPromisesForTenant,
  clearPromisedDueIfSettled,
} from '../common/helpers/promised-due.helper';

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

function daysBetween(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Phase 1 ageing heuristic (FIFO open debits):
 * Walk ledger chronologically. Positive amounts are open receivables;
 * credits reduce the oldest open debit first. Age = days since the oldest
 * remaining debit's createdAt (or last unpaid delivery sale / opening balance).
 */
function ageDaysFromLedger(
  entries: Array<{ amount: DecimalLike; createdAt: Date }>,
  now: Date,
): number | null {
  const open: Array<{ remaining: number; createdAt: Date }> = [];
  for (const entry of entries) {
    const amount = decimalToNumber(entry.amount);
    if (amount > 0) {
      open.push({ remaining: amount, createdAt: entry.createdAt });
      continue;
    }
    if (amount < 0) {
      let credit = -amount;
      while (credit > 0 && open.length > 0) {
        const oldest = open[0];
        const applied = Math.min(oldest.remaining, credit);
        oldest.remaining -= applied;
        credit -= applied;
        if (oldest.remaining <= 0.00001) open.shift();
      }
    }
  }
  if (open.length === 0) return null;
  return daysBetween(open[0].createdAt, now);
}

const paymentInclude = {
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
      paymentCycle: true,
      billingDueDate: true,
      billingAnchorDate: true,
    },
  },
  collectedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreatePaymentDto, actorId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    if (dto.collectedById) {
      const member = await this.prisma.tenantMember.findFirst({
        where: { tenantId, userId: dto.collectedById },
        select: { id: true },
      });
      if (!member) throw new BadRequestException('Collector must be a member of this tenant');
    }

    const paymentDate = parseDate(dto.paymentDate);
    const amount = new Prisma.Decimal(dto.amount);

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          amount,
          paymentDate,
          method: dto.method as PrismaPaymentMethod,
          collectedById: dto.collectedById ?? null,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
        },
      });

      await tx.customerLedgerEntry.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          entryType: PrismaLedgerEntryType.PAYMENT,
          amount: amount.neg(),
          referenceId: created.id,
          referenceType: 'payment',
          notes: dto.notes?.trim() || 'Standalone payment',
        },
      });

      await clearPromisedDueIfSettled(tx, tenantId, dto.customerId);

      return tx.payment.findFirstOrThrow({
        where: { id: created.id, tenantId },
        include: paymentInclude,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'payments',
      action: 'CREATE',
      entityId: payment.id,
      newValue: {
        customerId: payment.customerId,
        amount: decimalToNumber(payment.amount),
        method: payment.method,
        paymentDate: payment.paymentDate.toISOString(),
      },
    });

    return this.toDetail(payment);
  }

  async update(id: string, tenantId: string, dto: UpdatePaymentDto, actorId: string) {
    const existing = await this.prisma.payment.findFirst({
      where: { id, tenantId },
      include: paymentInclude,
    });
    if (!existing) throw new NotFoundException('Payment not found');

    if (dto.collectedById) {
      const member = await this.prisma.tenantMember.findFirst({
        where: { tenantId, userId: dto.collectedById },
        select: { id: true },
      });
      if (!member) throw new BadRequestException('Collector must be a member of this tenant');
    }

    const oldValue = {
      amount: decimalToNumber(existing.amount),
      paymentDate: existing.paymentDate.toISOString(),
      method: existing.method,
      collectedById: existing.collectedById,
      reference: existing.reference,
      notes: existing.notes,
    };

    const nextAmount = dto.amount !== undefined ? new Prisma.Decimal(dto.amount) : existing.amount;
    const nextDate =
      dto.paymentDate !== undefined ? parseDate(dto.paymentDate) : existing.paymentDate;
    const nextMethod =
      dto.method !== undefined ? (dto.method as PrismaPaymentMethod) : existing.method;
    const nextCollectedById =
      dto.collectedById !== undefined ? dto.collectedById || null : existing.collectedById;
    const nextReference = dto.reference !== undefined ? dto.reference : existing.reference;
    const nextNotes = dto.notes !== undefined ? dto.notes : existing.notes;

    const payment = await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          amount: nextAmount,
          paymentDate: nextDate,
          method: nextMethod,
          collectedById: nextCollectedById,
          reference: nextReference,
          notes: nextNotes,
        },
      });

      const ledger = await tx.customerLedgerEntry.findFirst({
        where: {
          tenantId,
          referenceType: 'payment',
          referenceId: id,
          entryType: PrismaLedgerEntryType.PAYMENT,
        },
      });
      if (!ledger) {
        throw new BadRequestException('Linked payment ledger entry not found');
      }

      await tx.customerLedgerEntry.update({
        where: { id: ledger.id },
        data: {
          amount: new Prisma.Decimal(nextAmount).neg(),
          ...(dto.notes !== undefined ? { notes: nextNotes?.trim() || 'Standalone payment' } : {}),
        },
      });

      await clearPromisedDueIfSettled(tx, tenantId, existing.customerId);

      return tx.payment.findFirstOrThrow({
        where: { id, tenantId },
        include: paymentInclude,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'payments',
      action: 'UPDATE',
      entityId: id,
      oldValue,
      newValue: {
        amount: decimalToNumber(payment.amount),
        paymentDate: payment.paymentDate.toISOString(),
        method: payment.method,
        collectedById: payment.collectedById,
        reference: payment.reference,
        notes: payment.notes,
      },
    });

    return this.toDetail(payment);
  }

  async remove(id: string, tenantId: string, actorId: string) {
    const existing = await this.prisma.payment.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException('Payment not found');

    await this.prisma.$transaction(async (tx) => {
      const ledger = await tx.customerLedgerEntry.findFirst({
        where: {
          tenantId,
          referenceType: 'payment',
          referenceId: id,
          entryType: PrismaLedgerEntryType.PAYMENT,
        },
      });

      if (ledger) {
        await tx.customerLedgerEntry.create({
          data: {
            tenantId,
            customerId: ledger.customerId,
            entryType: PrismaLedgerEntryType.ADJUSTMENT,
            amount: new Prisma.Decimal(ledger.amount).neg(),
            referenceId: id,
            referenceType: 'payment',
            notes: 'Cancel reversal for PAYMENT',
          },
        });
      }

      await tx.payment.delete({ where: { id } });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'payments',
      action: 'DELETE',
      entityId: id,
      oldValue: {
        customerId: existing.customerId,
        amount: decimalToNumber(existing.amount),
        method: existing.method,
        paymentDate: existing.paymentDate.toISOString(),
      },
    });
  }

  async list(
    tenantId: string,
    query: ListPaymentsQueryDto,
  ): Promise<PaginatedData<ReturnType<PaymentsService['toListItem']>>> {
    const { skip, take } = getPaginationParams(query);
    const where: Prisma.PaymentWhereInput = { tenantId };

    if (query.customerId) where.customerId = query.customerId;
    if (query.method) where.method = query.method as PrismaPaymentMethod;
    if (query.dateFrom || query.dateTo) {
      where.paymentDate = {};
      if (query.dateFrom) where.paymentDate.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.paymentDate.lte = endOfDay(query.dateTo);
    }

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take,
        orderBy: { paymentDate: 'desc' },
        include: paymentInclude,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItem(r)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id, tenantId },
      include: paymentInclude,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return this.toDetail(payment);
  }

  async dashboard(tenantId: string) {
    const now = new Date();
    const today = startOfDay(now);

    // Heal stale promises (e.g. paid promised amount but balance still open).
    await clearFulfilledPromisesForTenant(this.prisma, tenantId);

    const customers = await this.prisma.customer.findMany({
      where: { tenantId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        phone: true,
        paymentCycle: true,
        billingDueDate: true,
        billingAnchorDate: true,
        promisedDueDate: true,
        promisedDueAmount: true,
      },
    });

    if (customers.length === 0) {
      return {
        dueToday: [],
        overdue: [],
        ageing: {
          bucket_0_7: 0,
          bucket_8_30: 0,
          bucket_31_60: 0,
          bucket_60plus: 0,
        },
        totalOutstanding: 0,
      };
    }

    const customerIds = customers.map((c) => c.id);

    const balances = await this.prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customerIds } },
      _sum: { amount: true },
    });
    const balanceMap = new Map(balances.map((b) => [b.customerId, decimalToNumber(b._sum.amount)]));

    const lastPayments = await this.prisma.payment.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customerIds } },
      _max: { paymentDate: true },
    });
    const lastPaymentMap = new Map<string, Date | null>(
      lastPayments.map((p) => [p.customerId, p._max.paymentDate ?? null]),
    );

    const outstandingIds = customers
      .filter((c) => (balanceMap.get(c.id) ?? 0) > 0)
      .map((c) => c.id);

    const ledgerByCustomer = new Map<string, Array<{ amount: DecimalLike; createdAt: Date }>>();
    if (outstandingIds.length > 0) {
      const entries = await this.prisma.customerLedgerEntry.findMany({
        where: { tenantId, customerId: { in: outstandingIds } },
        select: { customerId: true, amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const e of entries) {
        const list = ledgerByCustomer.get(e.customerId) ?? [];
        list.push({ amount: e.amount, createdAt: e.createdAt });
        ledgerByCustomer.set(e.customerId, list);
      }
    }

    const ageing = {
      bucket_0_7: 0,
      bucket_8_30: 0,
      bucket_31_60: 0,
      bucket_60plus: 0,
    };
    let totalOutstanding = 0;

    type DueRow = {
      customerId: string;
      name: string;
      phone: string;
      balance: number;
      paymentCycle: string;
      billingDueDate: number | null;
      billingAnchorDate: string | null;
      lastPaymentDate: string | null;
      daysOverdue: number;
      ageDays: number;
      dueDate: string | null;
      promisedAmount: number | null;
      source: 'PROMISED' | 'CYCLE' | 'SOFT';
    };

    const dueToday: DueRow[] = [];
    const overdue: DueRow[] = [];

    for (const c of customers) {
      const balance = balanceMap.get(c.id) ?? 0;
      if (balance <= 0) continue;

      totalOutstanding += balance;
      const ageDays = ageDaysFromLedger(ledgerByCustomer.get(c.id) ?? [], now) ?? 0;
      if (ageDays <= 7) ageing.bucket_0_7 += balance;
      else if (ageDays <= 30) ageing.bucket_8_30 += balance;
      else if (ageDays <= 60) ageing.bucket_31_60 += balance;
      else ageing.bucket_60plus += balance;

      const lastPay = lastPaymentMap.get(c.id) ?? null;
      const promisedAmount =
        c.promisedDueAmount == null ? null : decimalToNumber(c.promisedDueAmount);

      const cycleNext = nextDueDate(c.paymentCycle, today, c.billingDueDate, c.billingAnchorDate);
      const cycleLast = lastDueDate(c.paymentCycle, today, c.billingDueDate, c.billingAnchorDate);

      // Promised due overrides cycle while set and balance is open.
      const usePromise = !!c.promisedDueDate;
      const effectiveDue = usePromise ? startOfDay(c.promisedDueDate as Date) : null;
      const source: DueRow['source'] = usePromise
        ? 'PROMISED'
        : c.paymentCycle === PrismaPaymentCycle.CASH_ON_DELIVERY
          ? 'SOFT'
          : 'CYCLE';

      const row: DueRow = {
        customerId: c.id,
        name: c.name,
        phone: c.phone,
        balance: Math.round(balance * 100) / 100,
        paymentCycle: c.paymentCycle,
        billingDueDate: c.billingDueDate,
        billingAnchorDate: c.billingAnchorDate
          ? c.billingAnchorDate.toISOString().slice(0, 10)
          : null,
        lastPaymentDate: lastPay ? lastPay.toISOString() : null,
        daysOverdue: 0,
        ageDays,
        dueDate: null,
        promisedAmount,
        source,
      };

      if (usePromise && effectiveDue) {
        row.dueDate = effectiveDue.toISOString().slice(0, 10);
        if (sameCalendarDay(effectiveDue, today)) {
          dueToday.push(row);
        } else if (today.getTime() > effectiveDue.getTime()) {
          row.daysOverdue = daysBetween(effectiveDue, now);
          overdue.push(row);
        }
        continue;
      }

      const isCod = c.paymentCycle === PrismaPaymentCycle.CASH_ON_DELIVERY;

      if (!isCod && cycleNext && sameCalendarDay(cycleNext, today)) {
        row.dueDate = cycleNext.toISOString().slice(0, 10);
        dueToday.push(row);
      }

      if (!isCod && cycleLast) {
        const pastDue = today.getTime() > cycleLast.getTime();
        const unpaidSinceDue = !lastPay || startOfDay(lastPay).getTime() < cycleLast.getTime();
        if (pastDue && unpaidSinceDue) {
          row.dueDate = cycleLast.toISOString().slice(0, 10);
          row.daysOverdue = daysBetween(cycleLast, now);
          overdue.push(row);
        }
      } else if (isCod && ageDays > 7) {
        row.daysOverdue = ageDays;
        overdue.push(row);
      }
    }

    overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);
    dueToday.sort((a, b) => b.balance - a.balance);

    return {
      dueToday,
      overdue,
      ageing: {
        bucket_0_7: Math.round(ageing.bucket_0_7 * 100) / 100,
        bucket_8_30: Math.round(ageing.bucket_8_30 * 100) / 100,
        bucket_31_60: Math.round(ageing.bucket_31_60 * 100) / 100,
        bucket_60plus: Math.round(ageing.bucket_60plus * 100) / 100,
      },
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
    };
  }

  private toListItem(row: {
    id: string;
    tenantId: string;
    customerId: string;
    amount: DecimalLike;
    paymentDate: Date;
    method: PrismaPaymentMethod;
    collectedById: string | null;
    reference: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    customer: { id: string; name: string; phone: string };
    collectedBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      amount: decimalToNumber(row.amount),
      paymentDate: row.paymentDate,
      method: row.method as PaymentMethod,
      collectedById: row.collectedById,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      customer: row.customer,
      collectedBy: row.collectedBy,
    };
  }

  private toDetail(
    row: Parameters<PaymentsService['toListItem']>[0] & {
      customer: {
        id: string;
        name: string;
        phone: string;
        paymentCycle: PrismaPaymentCycle;
        billingDueDate: number | null;
        billingAnchorDate: Date | null;
      };
    },
  ) {
    return {
      ...this.toListItem(row),
      customer: {
        id: row.customer.id,
        name: row.customer.name,
        phone: row.customer.phone,
        paymentCycle: row.customer.paymentCycle,
        billingDueDate: row.customer.billingDueDate,
        billingAnchorDate: row.customer.billingAnchorDate
          ? row.customer.billingAnchorDate.toISOString().slice(0, 10)
          : null,
      },
    };
  }
}
