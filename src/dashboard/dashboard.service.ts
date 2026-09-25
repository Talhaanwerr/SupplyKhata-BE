import { BadRequestException, Injectable } from '@nestjs/common';
import { DeliveryStatus as PrismaDeliveryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CashHandoversService } from '../cash-handovers/cash-handovers.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDay(value?: string): Date {
  if (!value) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
  return d;
}

function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly handovers: CashHandoversService,
  ) {}

  async get(tenantId: string, query: DashboardQueryDto) {
    const day = parseDay(query.date);
    const dayEnd = endOfDay(day);
    const monthStart = startOfMonth(day);
    const monthEnd = endOfMonth(day);

    const [
      todayDeliveries,
      monthDeliveries,
      todayExpensesAgg,
      monthExpensesAgg,
      monthRefillsAgg,
      outstanding,
      dues,
      riders,
    ] = await Promise.all([
      this.loadDeliveries(tenantId, day, dayEnd),
      this.loadDeliveries(tenantId, monthStart, monthEnd),
      this.prisma.expense.aggregate({
        where: { tenantId, date: { gte: day, lte: dayEnd } },
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { tenantId, date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      }),
      this.prisma.refillBatch.aggregate({
        where: { tenantId, date: { gte: monthStart, lte: monthEnd } },
        _sum: { totalCost: true },
      }),
      this.outstandingSummary(tenantId),
      this.payments.dashboard(tenantId),
      this.riderRows(tenantId, day, dayEnd),
    ]);

    const todayStats = this.aggregatePeriod(todayDeliveries);
    const monthStats = this.aggregatePeriod(monthDeliveries);
    const operatingExpenses = round2(decimalToNumber(monthExpensesAgg._sum.amount));
    const refillCOGS = round2(decimalToNumber(monthRefillsAgg._sum.totalCost));
    const grossProfit = round2(monthStats.totalSales - monthStats.totalCogs);
    const netProfit = round2(grossProfit - operatingExpenses);

    const dueToday = dues.dueToday ?? [];
    const collectionsDueTodayCount = dueToday.length;
    const collectionsDueTodayAmount = round2(
      dueToday.reduce(
        (sum: number, row: { promisedAmount?: number | null; balance?: number }) =>
          sum + (row.promisedAmount != null ? row.promisedAmount : (row.balance ?? 0)),
        0,
      ),
    );

    return {
      date: day.toISOString().slice(0, 10),
      today: {
        totalUnitsDelivered: todayStats.totalUnits,
        byProduct: todayStats.byProduct.map((p) => ({
          productId: p.productId,
          name: p.name,
          unitsDelivered: p.unitsDelivered,
        })),
        totalSales: todayStats.totalSales,
        cashCollected: todayStats.cashCollected,
        creditSales: round2(Math.max(0, todayStats.totalSales - todayStats.cashCollected)),
        totalExpenses: round2(decimalToNumber(todayExpensesAgg._sum.amount)),
        cashWithRiders: riders.reduce((s, r) => s + r.cashBalance, 0),
        outstandingCustomerCount: outstanding.count,
        outstandingAmount: outstanding.amount,
        collectionsDueTodayCount,
        collectionsDueTodayAmount,
      },
      thisMonth: {
        revenue: monthStats.totalSales,
        refillCOGS,
        operatingExpenses,
        grossProfit,
        netProfit,
        byProduct: monthStats.byProduct.map((p) => ({
          productId: p.productId,
          name: p.name,
          unitsDelivered: p.unitsDelivered,
          revenue: p.revenue,
          cogs: p.cogs,
          grossMargin: round2(p.revenue - p.cogs),
        })),
      },
      riderSummary: riders,
    };
  }

  private async loadDeliveries(tenantId: string, from: Date, to: Date) {
    return this.prisma.delivery.findMany({
      where: {
        tenantId,
        status: { not: PrismaDeliveryStatus.CANCELLED },
        deliveryDate: { gte: from, lte: to },
      },
      select: {
        cashReceived: true,
        deliveryRun: { select: { riderId: true } },
        items: {
          select: {
            productId: true,
            quantityDelivered: true,
            lineTotal: true,
            unitCostSnapshot: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  private aggregatePeriod(deliveries: Awaited<ReturnType<DashboardService['loadDeliveries']>>) {
    const byProduct = new Map<
      string,
      { productId: string; name: string; unitsDelivered: number; revenue: number; cogs: number }
    >();
    let totalSales = 0;
    let totalCogs = 0;
    let totalUnits = 0;
    let cashCollected = 0;

    for (const d of deliveries) {
      cashCollected += decimalToNumber(d.cashReceived);
      for (const item of d.items) {
        const units = decimalToNumber(item.quantityDelivered);
        const revenue = decimalToNumber(item.lineTotal);
        const cogs = units * decimalToNumber(item.unitCostSnapshot);
        totalUnits += units;
        totalSales += revenue;
        totalCogs += cogs;
        const prev = byProduct.get(item.productId) ?? {
          productId: item.productId,
          name: item.product.name,
          unitsDelivered: 0,
          revenue: 0,
          cogs: 0,
        };
        prev.unitsDelivered += units;
        prev.revenue += revenue;
        prev.cogs += cogs;
        byProduct.set(item.productId, prev);
      }
    }

    return {
      totalUnits,
      totalSales: round2(totalSales),
      totalCogs: round2(totalCogs),
      cashCollected: round2(cashCollected),
      byProduct: [...byProduct.values()]
        .map((p) => ({
          ...p,
          revenue: round2(p.revenue),
          cogs: round2(p.cogs),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private async outstandingSummary(tenantId: string) {
    const balances = await this.prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: {
        tenantId,
        customer: { deletedAt: null, status: 'ACTIVE' },
      },
      _sum: { amount: true },
    });
    let count = 0;
    let amount = 0;
    for (const row of balances) {
      const bal = decimalToNumber(row._sum.amount);
      if (bal > 0.00001) {
        count += 1;
        amount += bal;
      }
    }
    return { count, amount: round2(amount) };
  }

  private async riderRows(tenantId: string, day: Date, dayEnd: Date) {
    const members = await this.prisma.tenantMember.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        user: {
          deletedAt: null,
          roles: { some: { tenantId, role: { slug: 'rider' } } },
        },
      },
      select: {
        userId: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const results = [];
    for (const m of members) {
      const deliveries = await this.prisma.delivery.findMany({
        where: {
          tenantId,
          status: { not: PrismaDeliveryStatus.CANCELLED },
          deliveryDate: { gte: day, lte: dayEnd },
          deliveryRun: { riderId: m.userId },
        },
        select: {
          cashReceived: true,
          items: { select: { quantityDelivered: true } },
        },
      });
      let unitsDelivered = 0;
      let cashCollected = 0;
      for (const d of deliveries) {
        cashCollected += decimalToNumber(d.cashReceived);
        for (const item of d.items) unitsDelivered += decimalToNumber(item.quantityDelivered);
      }

      const handoversAgg = await this.prisma.cashHandover.aggregate({
        where: {
          tenantId,
          riderId: m.userId,
          handoverDate: { gte: day, lte: dayEnd },
        },
        _sum: { amount: true },
      });

      const balance = await this.handovers.riderCashBalance(tenantId, m.userId);

      results.push({
        riderId: m.userId,
        name: `${m.user.firstName} ${m.user.lastName}`.trim(),
        unitsDelivered,
        cashCollected: round2(cashCollected),
        cashHandedOver: round2(decimalToNumber(handoversAgg._sum.amount)),
        cashBalance: balance.currentBalance,
      });
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }
}
