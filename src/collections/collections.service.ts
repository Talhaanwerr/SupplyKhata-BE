import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CollectionVisitOutcome as PrismaCollectionVisitOutcome,
  PaymentCycle as PrismaPaymentCycle,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PaymentsService } from '../payments/payments.service';
import {
  lastDueDate,
  nextDueDate,
  sameCalendarDay,
  startOfDay,
} from '../payments/billing-due.helpers';
import { CollectionVisitOutcome } from '../common/enums/collection.enum';
import { PaymentMethod } from '../common/enums/delivery.enum';
import { CollectionBucket, CollectionsListQueryDto } from './dto/collections-list-query.dto';
import { RecordCollectionVisitDto } from './dto/record-collection-visit.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function daysBetween(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function ageDaysFromLedger(
  entries: Array<{ amount: DecimalLike; createdAt: Date }>,
  now: Date,
): number {
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
  if (open.length === 0) return 0;
  return daysBetween(open[0].createdAt, now);
}

function parseDay(value: string): Date {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
  return d;
}

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: CollectionsListQueryDto, actorId: string) {
    const today = query.date ? startOfDay(parseDay(query.date)) : startOfDay(new Date());
    const bucket = query.bucket ?? CollectionBucket.ALL;
    const riderOnly = await this.isRiderOnly(tenantId, actorId);
    const riderFilter = riderOnly ? actorId : query.riderId || undefined;

    const customers = await this.prisma.customer.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(riderFilter ? { defaultRiderId: riderFilter } : {}),
        ...(query.areaId ? { areaId: query.areaId } : {}),
        ...(query.search?.trim()
          ? {
              OR: [
                { name: { contains: query.search.trim() } },
                { phone: { contains: query.search.trim() } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        paymentCycle: true,
        billingDueDate: true,
        billingAnchorDate: true,
        promisedDueDate: true,
        promisedDueAmount: true,
        defaultRiderId: true,
        area: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (customers.length === 0) return { date: today.toISOString().slice(0, 10), items: [] };

    const customerIds = customers.map((c) => c.id);
    const [balances, lastPayments, ledgerEntries] = await Promise.all([
      this.prisma.customerLedgerEntry.groupBy({
        by: ['customerId'],
        where: { tenantId, customerId: { in: customerIds } },
        _sum: { amount: true },
      }),
      this.prisma.payment.groupBy({
        by: ['customerId'],
        where: { tenantId, customerId: { in: customerIds } },
        _max: { paymentDate: true },
      }),
      this.prisma.customerLedgerEntry.findMany({
        where: { tenantId, customerId: { in: customerIds } },
        select: { customerId: true, amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const balanceMap = new Map(balances.map((b) => [b.customerId, decimalToNumber(b._sum.amount)]));
    const lastPayMap = new Map(lastPayments.map((p) => [p.customerId, p._max.paymentDate ?? null]));
    const ledgerByCustomer = new Map<string, Array<{ amount: DecimalLike; createdAt: Date }>>();
    for (const e of ledgerEntries) {
      const list = ledgerByCustomer.get(e.customerId) ?? [];
      list.push({ amount: e.amount, createdAt: e.createdAt });
      ledgerByCustomer.set(e.customerId, list);
    }

    const now = new Date();
    const soonLimit = new Date(today);
    soonLimit.setDate(soonLimit.getDate() + 7);

    const items = [];
    for (const c of customers) {
      const balance = balanceMap.get(c.id) ?? 0;
      if (balance <= 0) continue;

      const ageDays = ageDaysFromLedger(ledgerByCustomer.get(c.id) ?? [], now);
      const lastPay = lastPayMap.get(c.id) ?? null;
      const usePromise = !!c.promisedDueDate;
      const cycleNext = nextDueDate(c.paymentCycle, today, c.billingDueDate, c.billingAnchorDate);
      const cycleLast = lastDueDate(c.paymentCycle, today, c.billingDueDate, c.billingAnchorDate);

      let dueDate: Date | null = null;
      let daysOverdue = 0;
      let rowBucket: CollectionBucket = CollectionBucket.ALL;

      if (usePromise && c.promisedDueDate) {
        dueDate = startOfDay(c.promisedDueDate);
        if (sameCalendarDay(dueDate, today)) rowBucket = CollectionBucket.DUE_TODAY;
        else if (today.getTime() > dueDate.getTime()) {
          rowBucket = CollectionBucket.OVERDUE;
          daysOverdue = daysBetween(dueDate, now);
        } else if (dueDate.getTime() <= soonLimit.getTime()) {
          rowBucket = CollectionBucket.DUE_SOON;
        }
      } else {
        const isCod = c.paymentCycle === PrismaPaymentCycle.CASH_ON_DELIVERY;
        if (!isCod && cycleNext && sameCalendarDay(cycleNext, today)) {
          dueDate = cycleNext;
          rowBucket = CollectionBucket.DUE_TODAY;
        } else if (!isCod && cycleLast) {
          const pastDue = today.getTime() > cycleLast.getTime();
          const unpaidSinceDue = !lastPay || startOfDay(lastPay).getTime() < cycleLast.getTime();
          if (pastDue && unpaidSinceDue) {
            dueDate = cycleLast;
            rowBucket = CollectionBucket.OVERDUE;
            daysOverdue = daysBetween(cycleLast, now);
          } else if (cycleNext && cycleNext.getTime() <= soonLimit.getTime()) {
            dueDate = cycleNext;
            rowBucket = CollectionBucket.DUE_SOON;
          }
        } else if (isCod && ageDays > 7) {
          rowBucket = CollectionBucket.OVERDUE;
          daysOverdue = ageDays;
        } else if (isCod) {
          rowBucket = CollectionBucket.DUE_SOON;
        }
      }

      if (bucket !== CollectionBucket.ALL && rowBucket !== bucket) continue;

      items.push({
        customerId: c.id,
        name: c.name,
        phone: c.phone,
        areaId: c.area.id,
        areaName: c.area.name,
        balance: Math.round(balance * 100) / 100,
        dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
        daysOverdue,
        ageDays,
        promisedAmount: c.promisedDueAmount == null ? null : decimalToNumber(c.promisedDueAmount),
        lastPaymentDate: lastPay ? lastPay.toISOString() : null,
        defaultRiderId: c.defaultRiderId,
        bucket: rowBucket,
      });
    }

    items.sort(
      (a, b) =>
        b.daysOverdue - a.daysOverdue || b.balance - a.balance || a.name.localeCompare(b.name),
    );

    return { date: today.toISOString().slice(0, 10), items };
  }

  async recordVisit(
    tenantId: string,
    customerId: string,
    dto: RecordCollectionVisitDto,
    actorId: string,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const riderOnly = await this.isRiderOnly(tenantId, actorId);
    if (riderOnly) {
      const assigned = await this.prisma.customer.findFirst({
        where: { id: customerId, tenantId, defaultRiderId: actorId },
        select: { id: true },
      });
      if (!assigned) {
        throw new BadRequestException('You can only collect for customers assigned to you');
      }
    }

    if (dto.amount != null && dto.amount > 0 && !dto.method) {
      throw new BadRequestException('Payment method is required when amount is set');
    }
    if (
      (dto.outcome === CollectionVisitOutcome.COLLECTED ||
        dto.outcome === CollectionVisitOutcome.PARTIAL) &&
      !(dto.amount != null && dto.amount > 0)
    ) {
      throw new BadRequestException('Amount is required for COLLECTED / PARTIAL outcomes');
    }
    if (dto.promiseAmount != null && dto.promiseAmount > 0 && !dto.promiseDate) {
      throw new BadRequestException('Promise date is required when promise amount is set');
    }

    const visitDate = dto.visitDate ? parseDay(dto.visitDate) : startOfDay(new Date());
    let paymentId: string | null = null;
    let amountCollected: number | null = null;

    if (dto.amount != null && dto.amount > 0) {
      const payment = await this.payments.create(
        tenantId,
        {
          customerId,
          amount: dto.amount,
          paymentDate: visitDate.toISOString().slice(0, 10),
          method: (dto.method ?? PaymentMethod.CASH) as PaymentMethod,
          collectedById: actorId,
          notes: dto.notes?.trim() || `Collection visit (${dto.outcome})`,
        },
        actorId,
      );
      paymentId = payment.id;
      amountCollected = dto.amount;
    }

    if (dto.promiseDate) {
      const promiseDate = parseDay(dto.promiseDate);
      await this.prisma.customer.update({
        where: { id: customerId },
        data: {
          promisedDueDate: promiseDate,
          promisedDueAmount:
            dto.promiseAmount != null && dto.promiseAmount > 0 ? dto.promiseAmount : null,
          promisedDueDeliveryId: null,
        },
      });
    }

    const visit = await this.prisma.collectionVisit.create({
      data: {
        tenantId,
        customerId,
        collectorId: actorId,
        visitDate,
        outcome: dto.outcome as PrismaCollectionVisitOutcome,
        amountCollected,
        paymentId,
        followUpDate: dto.followUpDate ? parseDay(dto.followUpDate) : null,
        notes: dto.notes?.trim() || null,
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        collector: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'collections',
      action: 'CREATE',
      entityId: visit.id,
      newValue: {
        customerId,
        outcome: dto.outcome,
        amountCollected,
        paymentId,
      },
    });

    return {
      id: visit.id,
      customerId: visit.customerId,
      customer: visit.customer,
      collectorId: visit.collectorId,
      collector: visit.collector,
      visitDate: visit.visitDate.toISOString().slice(0, 10),
      outcome: visit.outcome,
      amountCollected: amountCollected == null ? null : amountCollected,
      paymentId: visit.paymentId,
      followUpDate: visit.followUpDate ? visit.followUpDate.toISOString().slice(0, 10) : null,
      notes: visit.notes,
      createdAt: visit.createdAt,
    };
  }

  private async isRiderOnly(tenantId: string, userId: string): Promise<boolean> {
    const roles = await this.prisma.userRole.findMany({
      where: { tenantId, userId },
      select: { role: { select: { slug: true } } },
    });
    const slugs = roles.map((r) => r.role.slug);
    if (slugs.length === 0) return false;
    return slugs.every((s) => s === 'rider');
  }
}
