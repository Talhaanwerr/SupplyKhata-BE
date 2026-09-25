import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { DeliveryStatus as PrismaDeliveryStatus, Prisma } from '@prisma/client';
import type { Response } from 'express';
// pdfkit is CommonJS (`export =`); default import compiles to `.default` and breaks at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfkit CJS interop
import PDFDocument = require('pdfkit');
import { PrismaService } from '../prisma/prisma.service';
import { ContainerInventoryService } from '../container-inventory/container-inventory.service';
import { toCsv } from '../export/export.service';
import {
  CustomerLedgerReportQueryDto,
  DailySalesQueryDto,
  DateRangeQueryDto,
  ExpensesReportQueryDto,
  MonthlySummaryQueryDto,
  ReportExportQueryDto,
  RiderCollectionQueryDto,
  VehiclePerformanceQueryDto,
  CollectionPerformanceQueryDto,
} from './dto/reports-query.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDay(value: string, label = 'date'): Date {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label}`);
  return d;
}

function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const start = from ? parseDay(from, 'from') : todayStart();
  const end = to ? endOfDay(parseDay(to, 'to')) : endOfDay(start);
  if (end < start) throw new BadRequestException('to must be on or after from');
  return { from: start, to: end };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly containers: ContainerInventoryService,
  ) {}

  async dailySales(tenantId: string, query: DailySalesQueryDto) {
    const day = query.date ? parseDay(query.date) : todayStart();
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        tenantId,
        deliveryDate: { gte: day, lte: endOfDay(day) },
      },
      orderBy: { deliveryDate: 'asc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        deliveryRun: {
          select: {
            id: true,
            rider: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        items: {
          include: { product: { select: { id: true, name: true } } },
        },
      },
    });

    return {
      date: day.toISOString().slice(0, 10),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        status: d.status,
        customerId: d.customer.id,
        customerName: d.customer.name,
        customerPhone: d.customer.phone,
        riderName: `${d.deliveryRun.rider.firstName} ${d.deliveryRun.rider.lastName}`.trim(),
        deliveryRunId: d.deliveryRun.id,
        cashReceived: round2(decimalToNumber(d.cashReceived)),
        totalSale: round2(d.items.reduce((s, i) => s + decimalToNumber(i.lineTotal), 0)),
        items: d.items.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          quantityDelivered: decimalToNumber(i.quantityDelivered),
          emptiesReceived: i.emptiesReceived,
          unitPrice: round2(decimalToNumber(i.sellingPriceSnapshot)),
          lineTotal: round2(decimalToNumber(i.lineTotal)),
          unitCost: round2(decimalToNumber(i.unitCostSnapshot)),
        })),
      })),
    };
  }

  async monthlySummary(tenantId: string, query: MonthlySummaryQueryDto) {
    const from = new Date(query.year, query.month - 1, 1, 0, 0, 0, 0);
    const to = new Date(query.year, query.month, 0, 23, 59, 59, 999);
    const [deliveries, expensesAgg, refillAgg] = await Promise.all([
      this.prisma.delivery.findMany({
        where: {
          tenantId,
          status: { not: PrismaDeliveryStatus.CANCELLED },
          deliveryDate: { gte: from, lte: to },
        },
        select: {
          cashReceived: true,
          items: {
            select: {
              productId: true,
              quantityDelivered: true,
              lineTotal: true,
              unitCostSnapshot: true,
              product: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.expense.aggregate({
        where: { tenantId, date: { gte: from, lte: to } },
        _sum: { amount: true },
      }),
      this.prisma.refillBatch.aggregate({
        where: { tenantId, date: { gte: from, lte: to } },
        _sum: { totalCost: true },
      }),
    ]);

    const byProduct = new Map<
      string,
      { productId: string; name: string; unitsDelivered: number; revenue: number; cogs: number }
    >();
    let revenue = 0;
    let cogs = 0;
    for (const d of deliveries) {
      for (const item of d.items) {
        const rev = decimalToNumber(item.lineTotal);
        const qty = decimalToNumber(item.quantityDelivered);
        const cost = qty * decimalToNumber(item.unitCostSnapshot);
        revenue += rev;
        cogs += cost;
        const prev = byProduct.get(item.productId) ?? {
          productId: item.productId,
          name: item.product.name,
          unitsDelivered: 0,
          revenue: 0,
          cogs: 0,
        };
        prev.unitsDelivered += qty;
        prev.revenue += rev;
        prev.cogs += cost;
        byProduct.set(item.productId, prev);
      }
    }

    const operatingExpenses = round2(decimalToNumber(expensesAgg._sum.amount));
    const refillCOGS = round2(decimalToNumber(refillAgg._sum.totalCost));
    const grossProfit = round2(revenue - cogs);
    const netProfit = round2(grossProfit - operatingExpenses);

    return {
      month: query.month,
      year: query.year,
      revenue: round2(revenue),
      deliveryCOGS: round2(cogs),
      refillCOGS,
      operatingExpenses,
      grossProfit,
      netProfit,
      byProduct: [...byProduct.values()]
        .map((p) => ({
          ...p,
          revenue: round2(p.revenue),
          cogs: round2(p.cogs),
          grossMargin: round2(p.revenue - p.cogs),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async productPerformance(tenantId: string, query: DateRangeQueryDto) {
    const { from, to } = resolveRange(query.from, query.to);
    const items = await this.prisma.deliveryItem.findMany({
      where: {
        tenantId,
        delivery: {
          status: { not: PrismaDeliveryStatus.CANCELLED },
          deliveryDate: { gte: from, lte: to },
        },
      },
      select: {
        productId: true,
        quantityDelivered: true,
        lineTotal: true,
        unitCostSnapshot: true,
        product: { select: { name: true } },
      },
    });

    const map = new Map<
      string,
      { productId: string; name: string; unitsDelivered: number; revenue: number; cogs: number }
    >();
    for (const item of items) {
      const prev = map.get(item.productId) ?? {
        productId: item.productId,
        name: item.product.name,
        unitsDelivered: 0,
        revenue: 0,
        cogs: 0,
      };
      const qty = decimalToNumber(item.quantityDelivered);
      prev.unitsDelivered += qty;
      prev.revenue += decimalToNumber(item.lineTotal);
      prev.cogs += qty * decimalToNumber(item.unitCostSnapshot);
      map.set(item.productId, prev);
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      products: [...map.values()]
        .map((p) => ({
          ...p,
          revenue: round2(p.revenue),
          cogs: round2(p.cogs),
          grossMargin: round2(p.revenue - p.cogs),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  async customerOutstanding(tenantId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { tenantId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        phone: true,
        area: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
    if (customers.length === 0) return { customers: [], totalOutstanding: 0 };

    const balances = await this.prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customers.map((c) => c.id) } },
      _sum: { amount: true },
    });
    const balanceMap = new Map(balances.map((b) => [b.customerId, decimalToNumber(b._sum.amount)]));

    const outstandingIds = customers
      .filter((c) => (balanceMap.get(c.id) ?? 0) > 0.00001)
      .map((c) => c.id);
    const entries =
      outstandingIds.length === 0
        ? []
        : await this.prisma.customerLedgerEntry.findMany({
            where: { tenantId, customerId: { in: outstandingIds } },
            select: { customerId: true, amount: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          });

    const byCustomer = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byCustomer.get(e.customerId) ?? [];
      list.push(e);
      byCustomer.set(e.customerId, list);
    }

    const now = new Date();
    const rows = [];
    let totalOutstanding = 0;
    for (const c of customers) {
      const balance = round2(balanceMap.get(c.id) ?? 0);
      if (balance <= 0) continue;
      totalOutstanding += balance;
      rows.push({
        customerId: c.id,
        name: c.name,
        phone: c.phone,
        areaName: c.area?.name ?? null,
        balance,
        ageDays: this.ageDays(byCustomer.get(c.id) ?? [], now),
      });
    }

    return {
      customers: rows.sort((a, b) => b.balance - a.balance),
      totalOutstanding: round2(totalOutstanding),
    };
  }

  async customerLedger(tenantId: string, query: CustomerLedgerReportQueryDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: query.customerId, tenantId, deletedAt: null },
      select: { id: true, name: true, phone: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const { from, to } = resolveRange(query.from, query.to);
    const entries = await this.prisma.customerLedgerEntry.findMany({
      where: {
        tenantId,
        customerId: query.customerId,
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'asc' },
    });

    let running = 0;
    const before = await this.prisma.customerLedgerEntry.aggregate({
      where: { tenantId, customerId: query.customerId, createdAt: { lt: from } },
      _sum: { amount: true },
    });
    running = decimalToNumber(before._sum.amount);

    return {
      customer,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      openingBalance: round2(running),
      entries: entries.map((e) => {
        running += decimalToNumber(e.amount);
        return {
          id: e.id,
          entryType: e.entryType,
          amount: round2(decimalToNumber(e.amount)),
          balanceAfter: round2(running),
          referenceType: e.referenceType,
          referenceId: e.referenceId,
          notes: e.notes,
          createdAt: e.createdAt.toISOString(),
        };
      }),
      closingBalance: round2(running),
    };
  }

  async containerInventoryReport(tenantId: string) {
    const rows = await this.containers.inventory(tenantId);
    return { products: rows };
  }

  async riderCollection(tenantId: string, query: RiderCollectionQueryDto) {
    const { from, to } = resolveRange(query.from, query.to);
    const where: Prisma.DeliveryWhereInput = {
      tenantId,
      status: { not: PrismaDeliveryStatus.CANCELLED },
      deliveryDate: { gte: from, lte: to },
      ...(query.riderId ? { deliveryRun: { riderId: query.riderId } } : {}),
    };

    const deliveries = await this.prisma.delivery.findMany({
      where,
      select: {
        cashReceived: true,
        deliveryRun: {
          select: {
            riderId: true,
            rider: { select: { firstName: true, lastName: true } },
          },
        },
        items: { select: { quantityDelivered: true, lineTotal: true } },
        customer: { select: { id: true, name: true } },
      },
    });

    const byRider = new Map<
      string,
      {
        riderId: string;
        name: string;
        deliveriesCount: number;
        unitsDelivered: number;
        sales: number;
        cashCollected: number;
      }
    >();

    for (const d of deliveries) {
      const riderId = d.deliveryRun.riderId;
      const prev = byRider.get(riderId) ?? {
        riderId,
        name: `${d.deliveryRun.rider.firstName} ${d.deliveryRun.rider.lastName}`.trim(),
        deliveriesCount: 0,
        unitsDelivered: 0,
        sales: 0,
        cashCollected: 0,
      };
      prev.deliveriesCount += 1;
      prev.cashCollected += decimalToNumber(d.cashReceived);
      for (const item of d.items) {
        prev.unitsDelivered += decimalToNumber(item.quantityDelivered);
        prev.sales += decimalToNumber(item.lineTotal);
      }
      byRider.set(riderId, prev);
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      riders: [...byRider.values()]
        .map((r) => ({
          ...r,
          sales: round2(r.sales),
          cashCollected: round2(r.cashCollected),
        }))
        .sort((a, b) => b.cashCollected - a.cashCollected),
    };
  }

  async vehiclePerformance(tenantId: string, query: VehiclePerformanceQueryDto) {
    const { from, to } = resolveRange(query.from, query.to);
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(query.vehicleId ? { id: query.vehicleId } : {}),
      },
      select: { id: true, name: true, plateNumber: true },
      orderBy: { name: 'asc' },
    });
    if (vehicles.length === 0) {
      return {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        vehicles: [],
      };
    }

    const vehicleIds = vehicles.map((v) => v.id);
    const [runs, expenses] = await Promise.all([
      this.prisma.deliveryRun.findMany({
        where: {
          tenantId,
          vehicleId: { in: vehicleIds },
          date: { gte: from, lte: to },
        },
        select: {
          id: true,
          vehicleId: true,
          date: true,
          deliveries: {
            where: { status: { not: PrismaDeliveryStatus.CANCELLED } },
            select: {
              cashReceived: true,
              items: { select: { quantityDelivered: true, lineTotal: true } },
            },
          },
        },
      }),
      this.prisma.expense.findMany({
        where: {
          tenantId,
          vehicleId: { in: vehicleIds },
          date: { gte: from, lte: to },
        },
        select: { vehicleId: true, title: true, amount: true, date: true },
      }),
    ]);

    type Agg = {
      vehicleId: string;
      name: string;
      plateNumber: string | null;
      runsCount: number;
      deliveriesCount: number;
      unitsDelivered: number;
      totalSales: number;
      cashCollected: number;
      expenseTotal: number;
      expenseByTitle: Map<string, number>;
      seriesMap: Map<string, { date: string; runs: number; sales: number; expenses: number }>;
    };

    const byVehicle = new Map<string, Agg>();
    for (const v of vehicles) {
      byVehicle.set(v.id, {
        vehicleId: v.id,
        name: v.name,
        plateNumber: v.plateNumber,
        runsCount: 0,
        deliveriesCount: 0,
        unitsDelivered: 0,
        totalSales: 0,
        cashCollected: 0,
        expenseTotal: 0,
        expenseByTitle: new Map(),
        seriesMap: new Map(),
      });
    }

    const ensureDay = (agg: Agg, date: Date) => {
      const key = date.toISOString().slice(0, 10);
      let row = agg.seriesMap.get(key);
      if (!row) {
        row = { date: key, runs: 0, sales: 0, expenses: 0 };
        agg.seriesMap.set(key, row);
      }
      return row;
    };

    for (const run of runs) {
      const agg = byVehicle.get(run.vehicleId);
      if (!agg) continue;
      agg.runsCount += 1;
      const day = ensureDay(agg, run.date);
      day.runs += 1;
      for (const d of run.deliveries) {
        agg.deliveriesCount += 1;
        agg.cashCollected += decimalToNumber(d.cashReceived);
        for (const item of d.items) {
          const sale = decimalToNumber(item.lineTotal);
          agg.unitsDelivered += decimalToNumber(item.quantityDelivered);
          agg.totalSales += sale;
          day.sales += sale;
        }
      }
    }

    for (const e of expenses) {
      if (!e.vehicleId) continue;
      const agg = byVehicle.get(e.vehicleId);
      if (!agg) continue;
      const amt = decimalToNumber(e.amount);
      agg.expenseTotal += amt;
      const title = (e.title || 'Other').trim().toLowerCase() || 'other';
      agg.expenseByTitle.set(title, (agg.expenseByTitle.get(title) ?? 0) + amt);
      ensureDay(agg, e.date).expenses += amt;
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      vehicles: [...byVehicle.values()].map((agg) => ({
        vehicleId: agg.vehicleId,
        name: agg.name,
        plateNumber: agg.plateNumber,
        runsCount: agg.runsCount,
        deliveriesCount: agg.deliveriesCount,
        unitsDelivered: round2(agg.unitsDelivered),
        totalSales: round2(agg.totalSales),
        cashCollected: round2(agg.cashCollected),
        expenseTotal: round2(agg.expenseTotal),
        expenseBreakdown: [...agg.expenseByTitle.entries()]
          .map(([title, amount]) => ({ title, amount: round2(amount) }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 10),
        series: [...agg.seriesMap.values()]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((s) => ({
            date: s.date,
            runs: s.runs,
            sales: round2(s.sales),
            expenses: round2(s.expenses),
          })),
      })),
    };
  }

  async collectionPerformance(tenantId: string, query: CollectionPerformanceQueryDto) {
    const { from, to } = resolveRange(query.from, query.to);
    const visits = await this.prisma.collectionVisit.findMany({
      where: {
        tenantId,
        visitDate: { gte: from, lte: to },
        ...(query.collectorId ? { collectorId: query.collectorId } : {}),
        ...(query.areaId ? { customer: { areaId: query.areaId } } : {}),
      },
      select: {
        collectorId: true,
        outcome: true,
        amountCollected: true,
        customer: { select: { areaId: true, area: { select: { id: true, name: true } } } },
        collector: { select: { firstName: true, lastName: true } },
      },
    });

    const byCollector = new Map<
      string,
      {
        staffId: string;
        name: string;
        visits: number;
        collectedAmount: number;
        promisedCount: number;
        noContactCount: number;
      }
    >();
    const byArea = new Map<
      string,
      { areaId: string; name: string; collectedAmount: number; customersVisited: number }
    >();

    for (const v of visits) {
      const cPrev = byCollector.get(v.collectorId) ?? {
        staffId: v.collectorId,
        name: `${v.collector.firstName} ${v.collector.lastName}`.trim(),
        visits: 0,
        collectedAmount: 0,
        promisedCount: 0,
        noContactCount: 0,
      };
      cPrev.visits += 1;
      cPrev.collectedAmount += decimalToNumber(v.amountCollected);
      if (v.outcome === 'PROMISED') cPrev.promisedCount += 1;
      if (v.outcome === 'NO_CONTACT') cPrev.noContactCount += 1;
      byCollector.set(v.collectorId, cPrev);

      const areaId = v.customer.areaId;
      const aPrev = byArea.get(areaId) ?? {
        areaId,
        name: v.customer.area?.name ?? 'Area',
        collectedAmount: 0,
        customersVisited: 0,
      };
      aPrev.customersVisited += 1;
      aPrev.collectedAmount += decimalToNumber(v.amountCollected);
      byArea.set(areaId, aPrev);
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      collectors: [...byCollector.values()]
        .map((c) => ({ ...c, collectedAmount: round2(c.collectedAmount) }))
        .sort((a, b) => b.collectedAmount - a.collectedAmount),
      byArea: [...byArea.values()]
        .map((a) => ({ ...a, collectedAmount: round2(a.collectedAmount) }))
        .sort((a, b) => b.collectedAmount - a.collectedAmount),
    };
  }

  async expensesReport(tenantId: string, query: ExpensesReportQueryDto) {
    const { from, to } = resolveRange(query.from, query.to);
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        date: { gte: from, lte: to },
        ...(query.search?.trim() ? { title: { contains: query.search.trim() } } : {}),
      },
      orderBy: { date: 'desc' },
      include: {
        vehicle: { select: { id: true, name: true } },
        staff: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const total = round2(expenses.reduce((s, e) => s + decimalToNumber(e.amount), 0));
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      total,
      expenses: expenses.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        date: e.date.toISOString().slice(0, 10),
        amount: round2(decimalToNumber(e.amount)),
        paymentMethod: e.paymentMethod,
        isPaidByRider: e.isPaidByRider,
        vehicleName: e.vehicle?.name ?? null,
        staffName: e.staff ? `${e.staff.firstName} ${e.staff.lastName}`.trim() : null,
      })),
    };
  }

  async export(
    tenantId: string,
    query: ReportExportQueryDto,
    res: Response,
  ): Promise<StreamableFile> {
    const format = query.format === 'pdf' ? 'pdf' : 'csv';
    const { rows, title, headers } = await this.buildExportRows(tenantId, query);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${query.type}-${stamp}.${format}`;

    if (format === 'csv') {
      const csv = toCsv(rows, headers);
      const buffer = Buffer.from(csv, 'utf-8');
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length.toString(),
      });
      return new StreamableFile(buffer);
    }

    const buffer = await this.buildPdf(title, headers, rows);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });
    return new StreamableFile(buffer);
  }

  private async buildExportRows(tenantId: string, query: ReportExportQueryDto) {
    switch (query.type) {
      case 'daily-sales': {
        const data = await this.dailySales(tenantId, { date: query.date });
        const rows: Record<string, unknown>[] = [];
        for (const d of data.deliveries) {
          for (const item of d.items) {
            rows.push({
              deliveryId: d.id,
              status: d.status,
              customer: d.customerName,
              rider: d.riderName,
              product: item.productName,
              qty: item.quantityDelivered,
              empties: item.emptiesReceived,
              unitPrice: item.unitPrice,
              lineTotal: item.lineTotal,
              cashReceived: d.cashReceived,
            });
          }
        }
        return {
          title: `Daily Sales ${data.date}`,
          headers: [
            'deliveryId',
            'status',
            'customer',
            'rider',
            'product',
            'qty',
            'empties',
            'unitPrice',
            'lineTotal',
            'cashReceived',
          ],
          rows,
        };
      }
      case 'monthly-summary': {
        if (!query.month || !query.year) {
          throw new BadRequestException('month and year are required');
        }
        const data = await this.monthlySummary(tenantId, {
          month: query.month,
          year: query.year,
        });
        return {
          title: `Monthly Summary ${query.year}-${String(query.month).padStart(2, '0')}`,
          headers: ['productId', 'name', 'unitsDelivered', 'revenue', 'cogs', 'grossMargin'],
          rows: data.byProduct as unknown as Record<string, unknown>[],
        };
      }
      case 'product-performance': {
        const data = await this.productPerformance(tenantId, {
          from: query.from,
          to: query.to,
        });
        return {
          title: `Product Performance ${data.from} to ${data.to}`,
          headers: ['productId', 'name', 'unitsDelivered', 'revenue', 'cogs', 'grossMargin'],
          rows: data.products as unknown as Record<string, unknown>[],
        };
      }
      case 'customer-outstanding': {
        const data = await this.customerOutstanding(tenantId);
        return {
          title: 'Customer Outstanding',
          headers: ['customerId', 'name', 'phone', 'areaName', 'balance', 'ageDays'],
          rows: data.customers as unknown as Record<string, unknown>[],
        };
      }
      case 'customer-ledger': {
        if (!query.customerId) throw new BadRequestException('customerId is required');
        const data = await this.customerLedger(tenantId, {
          customerId: query.customerId,
          from: query.from,
          to: query.to,
        });
        return {
          title: `Customer Ledger ${data.customer.name}`,
          headers: [
            'createdAt',
            'entryType',
            'amount',
            'balanceAfter',
            'referenceType',
            'referenceId',
            'notes',
          ],
          rows: data.entries as unknown as Record<string, unknown>[],
        };
      }
      case 'container-inventory': {
        const data = await this.containerInventoryReport(tenantId);
        return {
          title: 'Container Inventory',
          headers: [
            'productId',
            'productName',
            'ownedTotal',
            'withCustomers',
            'onVehicles',
            'onHand',
          ],
          rows: data.products.map((p) => ({
            productId: p.productId,
            productName: p.productName,
            ownedTotal: p.ownedTotal,
            withCustomers: p.withCustomers,
            onVehicles: p.onVehicles,
            onHand: p.onHand,
          })),
        };
      }
      case 'rider-collection': {
        const data = await this.riderCollection(tenantId, {
          from: query.from,
          to: query.to,
          riderId: query.riderId,
        });
        return {
          title: `Rider Collection ${data.from} to ${data.to}`,
          headers: [
            'riderId',
            'name',
            'deliveriesCount',
            'unitsDelivered',
            'sales',
            'cashCollected',
          ],
          rows: data.riders as unknown as Record<string, unknown>[],
        };
      }
      case 'expenses': {
        const data = await this.expensesReport(tenantId, {
          from: query.from,
          to: query.to,
          search: query.search,
        });
        return {
          title: `Expenses ${data.from} to ${data.to}`,
          headers: [
            'date',
            'title',
            'amount',
            'paymentMethod',
            'isPaidByRider',
            'vehicleName',
            'staffName',
            'description',
          ],
          rows: data.expenses.map((e) => ({
            date: e.date,
            title: e.title,
            amount: e.amount,
            paymentMethod: e.paymentMethod,
            isPaidByRider: e.isPaidByRider,
            vehicleName: e.vehicleName,
            staffName: e.staffName,
            description: e.description,
          })),
        };
      }
      default:
        throw new BadRequestException(
          'type must be one of: daily-sales, monthly-summary, product-performance, customer-outstanding, customer-ledger, container-inventory, rider-collection, expenses',
        );
    }
  }

  private buildPdf(
    title: string,
    headers: string[],
    rows: Record<string, unknown>[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(14).text(title, { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(8).text(headers.join(' | '));
      doc.moveDown(0.3);
      for (const row of rows.slice(0, 500)) {
        const line = headers.map((h) => String(row[h] ?? '')).join(' | ');
        doc.text(line, { lineBreak: true });
      }
      if (rows.length > 500) {
        doc.moveDown().text(`… truncated ${rows.length - 500} more rows`);
      }
      doc.end();
    });
  }

  private ageDays(entries: Array<{ amount: DecimalLike; createdAt: Date }>, now: Date): number {
    let remaining = entries.reduce((s, e) => s + decimalToNumber(e.amount), 0);
    if (remaining <= 0) return 0;
    for (const e of entries) {
      const amt = decimalToNumber(e.amount);
      if (amt <= 0) continue;
      // Walk oldest positive contribution still in balance
      remaining -= amt;
      if (remaining <= 0.00001) {
        return Math.max(
          0,
          Math.floor((now.getTime() - e.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
        );
      }
    }
    const first = entries.find((e) => decimalToNumber(e.amount) > 0);
    if (!first) return 0;
    return Math.max(
      0,
      Math.floor((now.getTime() - first.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    );
  }
}
