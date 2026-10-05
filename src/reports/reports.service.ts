import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import {
  DeliveryStatus as PrismaDeliveryStatus,
  OrderStatus as PrismaOrderStatus,
  Prisma,
} from '@prisma/client';
import type { Response } from 'express';
// pdfkit is CommonJS (`export =`); default import compiles to `.default` and breaks at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfkit CJS interop
import PDFDocument = require('pdfkit');
import { PrismaService } from '../prisma/prisma.service';
import { ContainerInventoryService } from '../container-inventory/container-inventory.service';
import { toCsv } from '../export/export.service';
import { isOrdersEnabled } from '../common/helpers/orders.helper';
import { isInventoryEnabled } from '../common/helpers/inventory.helper';
import { isRawMaterialsEnabled } from '../common/helpers/raw-materials.helper';
import { isPurchaseOrdersEnabled } from '../common/helpers/purchase-orders.helper';
import { isVendorBillsEnabled } from '../common/helpers/vendor-bills.helper';
import { isProductionEnabled } from '../common/helpers/production.helper';
import { isVendorsEnabled } from '../common/helpers/vendors.helper';
import {
  endOfUtcDay,
  formatCalendarDateUtc,
  parseCalendarDateUtc,
  startOfTodayInTimeZoneUtc,
} from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';
import {
  CustomerLedgerReportQueryDto,
  DailySalesQueryDto,
  DateRangeQueryDto,
  ExpensesReportQueryDto,
  MonthlySummaryQueryDto,
  ProductionYieldQueryDto,
  PurchasesByVendorQueryDto,
  RawConsumptionQueryDto,
  ReportExportQueryDto,
  ReportSalesChannel,
  RiderCollectionQueryDto,
  StockOnHandQueryDto,
  VehiclePerformanceQueryDto,
  CollectionPerformanceQueryDto,
} from './dto/reports-query.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

/** Fulfillment statuses that count as order sales (ORDER_SALE posted; not cancelled/refunded). */
const BILLABLE_ORDER_STATUSES: PrismaOrderStatus[] = [
  PrismaOrderStatus.PLACED,
  PrismaOrderStatus.SHIPPED,
  PrismaOrderStatus.PARTIALLY_DELIVERED,
  PrismaOrderStatus.DELIVERED,
];

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDay(value: string, label = 'date'): Date {
  const d = parseCalendarDateUtc(value, false);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label}`);
  return d;
}

function endOfDay(d: Date): Date {
  return endOfUtcDay(d);
}

async function resolveRange(
  prisma: PrismaService,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<{ from: Date; to: Date }> {
  const tz = await getTenantTimezone(prisma, tenantId);
  const start = from ? parseDay(from, 'from') : startOfTodayInTimeZoneUtc(tz);
  const end = to ? endOfDay(parseDay(to, 'to')) : endOfDay(start);
  if (end < start) throw new BadRequestException('to must be on or after from');
  return { from: start, to: end };
}

function resolveChannel(channel?: ReportSalesChannel): ReportSalesChannel {
  return channel === 'orders' ? 'orders' : 'delivery';
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly containers: ContainerInventoryService,
  ) {}

  async dailySales(tenantId: string, query: DailySalesQueryDto) {
    const tz = await getTenantTimezone(this.prisma, tenantId);
    const day = query.date ? parseDay(query.date) : startOfTodayInTimeZoneUtc(tz);
    const channel = await this.resolveSalesChannel(tenantId, query.channel);
    const dateStr = formatCalendarDateUtc(day);

    if (channel === 'orders') {
      const orders = await this.loadBillableOrdersInRange(tenantId, day, endOfDay(day));
      return {
        date: dateStr,
        channel,
        deliveries: [] as Array<never>,
        orders: orders.map((o) => this.mapOrderSaleRow(o)),
      };
    }

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
      date: dateStr,
      channel,
      orders: [] as Array<never>,
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
    const channel = await this.resolveSalesChannel(tenantId, query.channel);

    const [expensesAgg, refillAgg] = await Promise.all([
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

    if (channel === 'orders') {
      const orders = await this.loadBillableOrdersInRange(tenantId, from, to);
      for (const order of orders) {
        revenue += decimalToNumber(order.total);
        for (const item of order.items) {
          const rev = decimalToNumber(item.lineTotal);
          const qty = decimalToNumber(item.quantity);
          const cost = item.costSnapshot != null ? qty * decimalToNumber(item.costSnapshot) : 0;
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
    } else {
      const deliveries = await this.prisma.delivery.findMany({
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
      });

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
    }

    const operatingExpenses = round2(decimalToNumber(expensesAgg._sum.amount));
    const refillCOGS = round2(decimalToNumber(refillAgg._sum.totalCost));
    const grossProfit = round2(revenue - cogs);
    const netProfit = round2(grossProfit - operatingExpenses);

    return {
      month: query.month,
      year: query.year,
      channel,
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
    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
    const channel = await this.resolveSalesChannel(tenantId, query.channel);

    const map = new Map<
      string,
      { productId: string; name: string; unitsDelivered: number; revenue: number; cogs: number }
    >();

    if (channel === 'orders') {
      const orders = await this.loadBillableOrdersInRange(tenantId, from, to);
      for (const order of orders) {
        for (const item of order.items) {
          const prev = map.get(item.productId) ?? {
            productId: item.productId,
            name: item.product.name,
            unitsDelivered: 0,
            revenue: 0,
            cogs: 0,
          };
          const qty = decimalToNumber(item.quantity);
          prev.unitsDelivered += qty;
          prev.revenue += decimalToNumber(item.lineTotal);
          if (item.costSnapshot != null) {
            prev.cogs += qty * decimalToNumber(item.costSnapshot);
          }
          map.set(item.productId, prev);
        }
      }
    } else {
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
    }

    return {
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      channel,
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

  private async resolveSalesChannel(
    tenantId: string,
    channel?: ReportSalesChannel,
  ): Promise<ReportSalesChannel> {
    const resolved = resolveChannel(channel);
    if (resolved === 'orders' && !(await isOrdersEnabled(this.prisma, tenantId))) {
      throw new BadRequestException('Orders are disabled for this workspace');
    }
    return resolved;
  }

  /**
   * Billable orders whose PLACED event falls in [from, to].
   * Excludes DRAFT / CANCELLED / REFUNDED. Matches ORDER_SALE recognition date.
   */
  private async loadBillableOrdersInRange(tenantId: string, from: Date, to: Date) {
    const placedEvents = await this.prisma.orderStatusEvent.findMany({
      where: {
        tenantId,
        toStatus: PrismaOrderStatus.PLACED,
        at: { gte: from, lte: to },
        order: {
          tenantId,
          deletedAt: null,
          status: { in: BILLABLE_ORDER_STATUSES },
        },
      },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    const orderIds = placedEvents.map((e) => e.orderId);
    if (orderIds.length === 0) return [];

    return this.prisma.customerOrder.findMany({
      where: {
        tenantId,
        id: { in: orderIds },
        deletedAt: null,
        status: { in: BILLABLE_ORDER_STATUSES },
      },
      orderBy: { orderNumber: 'asc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        items: {
          include: { product: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  private mapOrderSaleRow(
    o: Awaited<ReturnType<ReportsService['loadBillableOrdersInRange']>>[number],
  ) {
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      customerId: o.customer.id,
      customerName: o.customer.name,
      customerPhone: o.customer.phone,
      subtotal: round2(decimalToNumber(o.subtotal)),
      discountTotal: round2(decimalToNumber(o.discountTotal)),
      deliveryCharges: round2(decimalToNumber(o.deliveryCharges)),
      total: round2(decimalToNumber(o.total)),
      amountPaid: round2(decimalToNumber(o.amountPaid)),
      amountDue: round2(decimalToNumber(o.amountDue)),
      items: o.items.map((i) => ({
        productId: i.productId,
        productName: i.product.name,
        quantity: decimalToNumber(i.quantity),
        quantityDelivered: decimalToNumber(i.quantityDelivered),
        unitPrice: round2(decimalToNumber(i.unitPriceSnapshot)),
        lineTotal: round2(decimalToNumber(i.lineTotal)),
        unitCost: i.costSnapshot != null ? round2(decimalToNumber(i.costSnapshot)) : null,
      })),
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

    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
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
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
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
    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
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
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
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
    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
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
        from: formatCalendarDateUtc(from),
        to: formatCalendarDateUtc(to),
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
      const key = formatCalendarDateUtc(date);
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
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
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
    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
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
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      collectors: [...byCollector.values()]
        .map((c) => ({ ...c, collectedAmount: round2(c.collectedAmount) }))
        .sort((a, b) => b.collectedAmount - a.collectedAmount),
      byArea: [...byArea.values()]
        .map((a) => ({ ...a, collectedAmount: round2(a.collectedAmount) }))
        .sort((a, b) => b.collectedAmount - a.collectedAmount),
    };
  }

  async expensesReport(tenantId: string, query: ExpensesReportQueryDto) {
    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
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
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      total,
      expenses: expenses.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        date: formatCalendarDateUtc(e.date),
        amount: round2(decimalToNumber(e.amount)),
        paymentMethod: e.paymentMethod,
        isPaidByRider: e.isPaidByRider,
        vehicleName: e.vehicle?.name ?? null,
        staffName: e.staff ? `${e.staff.firstName} ${e.staff.lastName}`.trim() : null,
      })),
    };
  }

  /** Finished goods + raw on-hand. Empty sections when flags OFF — never queries DeliveryRunStock. */
  async stockOnHand(tenantId: string, query: StockOnHandQueryDto) {
    const inventoryOn = await isInventoryEnabled(this.prisma, tenantId);
    const rawOn = await isRawMaterialsEnabled(this.prisma, tenantId);

    const finished = inventoryOn
      ? (
          await this.prisma.stockBalance.findMany({
            where: {
              tenantId,
              ...(query.locationId ? { locationId: query.locationId } : {}),
            },
            orderBy: [{ locationId: 'asc' }, { productId: 'asc' }],
            include: {
              product: { select: { id: true, name: true, sku: true, baseUnit: true } },
              location: { select: { id: true, name: true, isDefault: true } },
            },
          })
        ).map((r) => ({
          productId: r.productId,
          productName: r.product.name,
          sku: r.product.sku,
          baseUnit: r.product.baseUnit,
          locationId: r.locationId,
          locationName: r.location.name,
          quantity: round2(decimalToNumber(r.quantity)),
        }))
      : [];

    const raw = rawOn
      ? (
          await this.prisma.rawMaterialBalance.findMany({
            where: {
              tenantId,
              ...(query.locationId ? { locationId: query.locationId } : {}),
            },
            orderBy: [{ locationId: 'asc' }, { rawMaterialId: 'asc' }],
            include: {
              rawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
              location: { select: { id: true, name: true, isDefault: true } },
            },
          })
        ).map((r) => ({
          rawMaterialId: r.rawMaterialId,
          rawMaterialName: r.rawMaterial.name,
          sku: r.rawMaterial.sku,
          unit: r.rawMaterial.unit,
          locationId: r.locationId,
          locationName: r.location.name,
          quantity: round2(decimalToNumber(r.quantity)),
        }))
      : [];

    return {
      inventoryEnabled: inventoryOn,
      rawMaterialsEnabled: rawOn,
      locationId: query.locationId ?? null,
      finished,
      raw,
      notes: [
        !inventoryOn ? 'Enable Inventory for finished-goods on-hand.' : null,
        !rawOn ? 'Enable Raw Materials for raw on-hand.' : null,
      ].filter(Boolean),
    };
  }

  async purchasesByVendor(tenantId: string, query: PurchasesByVendorQueryDto) {
    const vendorsOn = await isVendorsEnabled(this.prisma, tenantId);
    const poOn = await isPurchaseOrdersEnabled(this.prisma, tenantId);
    const billsOn = await isVendorBillsEnabled(this.prisma, tenantId);
    if (!vendorsOn) {
      return {
        vendorsEnabled: false,
        purchaseOrdersEnabled: poOn,
        vendorBillsEnabled: billsOn,
        from: query.from ?? null,
        to: query.to ?? null,
        vendors: [],
        notes: ['Enable Vendors to view purchases by vendor.'],
      };
    }

    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
    const vendorFilter = query.vendorId ? { vendorId: query.vendorId } : {};

    const vendors = await this.prisma.vendor.findMany({
      where: {
        tenantId,
        ...(query.vendorId ? { id: query.vendorId } : {}),
        isActive: true,
      },
      select: { id: true, name: true, phone: true },
      orderBy: { name: 'asc' },
    });

    const poRows = poOn
      ? await this.prisma.purchaseOrder.findMany({
          where: {
            tenantId,
            ...vendorFilter,
            createdAt: { gte: from, lte: to },
            status: { not: 'CANCELLED' },
          },
          include: { lines: true },
        })
      : [];

    const billRows = billsOn
      ? await this.prisma.vendorBill.findMany({
          where: {
            tenantId,
            ...vendorFilter,
            billDate: { gte: from, lte: to },
            status: { not: 'VOID' },
          },
          select: {
            vendorId: true,
            totalAmount: true,
            paidAmount: true,
            status: true,
          },
        })
      : [];

    const byVendor = new Map<
      string,
      {
        vendorId: string;
        vendorName: string;
        phone: string | null;
        poCount: number;
        poOrderedAmount: number;
        billCount: number;
        billTotal: number;
        billPaid: number;
      }
    >();

    for (const v of vendors) {
      byVendor.set(v.id, {
        vendorId: v.id,
        vendorName: v.name,
        phone: v.phone,
        poCount: 0,
        poOrderedAmount: 0,
        billCount: 0,
        billTotal: 0,
        billPaid: 0,
      });
    }

    for (const po of poRows) {
      let row = byVendor.get(po.vendorId);
      if (!row) {
        row = {
          vendorId: po.vendorId,
          vendorName: 'Unknown',
          phone: null,
          poCount: 0,
          poOrderedAmount: 0,
          billCount: 0,
          billTotal: 0,
          billPaid: 0,
        };
        byVendor.set(po.vendorId, row);
      }
      row.poCount += 1;
      row.poOrderedAmount += po.lines.reduce(
        (s, l) => s + decimalToNumber(l.qtyOrdered) * decimalToNumber(l.unitCost),
        0,
      );
    }

    for (const b of billRows) {
      let row = byVendor.get(b.vendorId);
      if (!row) {
        row = {
          vendorId: b.vendorId,
          vendorName: 'Unknown',
          phone: null,
          poCount: 0,
          poOrderedAmount: 0,
          billCount: 0,
          billTotal: 0,
          billPaid: 0,
        };
        byVendor.set(b.vendorId, row);
      }
      row.billCount += 1;
      row.billTotal += decimalToNumber(b.totalAmount);
      row.billPaid += decimalToNumber(b.paidAmount);
    }

    const list = [...byVendor.values()]
      .filter((v) => v.poCount > 0 || v.billCount > 0 || !!query.vendorId)
      .map((v) => ({
        ...v,
        poOrderedAmount: round2(v.poOrderedAmount),
        billTotal: round2(v.billTotal),
        billPaid: round2(v.billPaid),
        billOutstanding: round2(v.billTotal - v.billPaid),
      }))
      .sort((a, b) => b.billTotal + b.poOrderedAmount - (a.billTotal + a.poOrderedAmount));

    return {
      vendorsEnabled: true,
      purchaseOrdersEnabled: poOn,
      vendorBillsEnabled: billsOn,
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      vendors: list,
      notes: [
        !poOn ? 'Enable Purchase Orders for PO totals.' : null,
        !billsOn ? 'Enable Vendor Bills for bill totals.' : null,
      ].filter(Boolean),
    };
  }

  async productionYield(tenantId: string, query: ProductionYieldQueryDto) {
    const productionOn = await isProductionEnabled(this.prisma, tenantId);
    if (!productionOn) {
      return {
        productionEnabled: false,
        from: query.from ?? null,
        to: query.to ?? null,
        orders: [],
        notes: ['Enable Production for yield report.'],
      };
    }

    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
    const orders = await this.prisma.productionOrder.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        completedAt: { gte: from, lte: to },
        ...(query.productId ? { productId: query.productId } : {}),
      },
      orderBy: { completedAt: 'desc' },
      include: {
        product: { select: { id: true, name: true, sku: true } },
      },
    });

    return {
      productionEnabled: true,
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      orders: orders.map((o) => {
        const planned = decimalToNumber(o.plannedQty);
        const actual = decimalToNumber(o.actualQty);
        return {
          id: o.id,
          productId: o.productId,
          productName: o.product.name,
          sku: o.product.sku,
          plannedQty: round2(planned),
          actualQty: round2(actual),
          scrapQty: round2(decimalToNumber(o.scrapQty)),
          varianceQty: round2(actual - planned),
          varianceNote: o.varianceNote,
          scrapReason: o.scrapReason,
          completedAt: o.completedAt?.toISOString() ?? null,
        };
      }),
      notes: [] as string[],
    };
  }

  async rawConsumption(tenantId: string, query: RawConsumptionQueryDto) {
    const productionOn = await isProductionEnabled(this.prisma, tenantId);
    const rawOn = await isRawMaterialsEnabled(this.prisma, tenantId);
    if (!productionOn || !rawOn) {
      return {
        productionEnabled: productionOn,
        rawMaterialsEnabled: rawOn,
        from: query.from ?? null,
        to: query.to ?? null,
        lines: [],
        notes: [
          !productionOn ? 'Enable Production for consumption data.' : null,
          !rawOn ? 'Enable Raw Materials for consumption data.' : null,
        ].filter(Boolean),
      };
    }

    const { from, to } = await resolveRange(this.prisma, tenantId, query.from, query.to);
    const rows = await this.prisma.productionConsumeLine.findMany({
      where: {
        tenantId,
        ...(query.rawMaterialId ? { rawMaterialId: query.rawMaterialId } : {}),
        productionOrder: {
          status: 'COMPLETED',
          completedAt: { gte: from, lte: to },
          ...(query.productId ? { productId: query.productId } : {}),
        },
      },
      include: {
        rawMaterial: { select: { id: true, name: true, unit: true, sku: true } },
        productionOrder: {
          select: {
            id: true,
            productId: true,
            completedAt: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
    });

    const aggregated = new Map<
      string,
      {
        rawMaterialId: string;
        rawMaterialName: string;
        unit: string;
        sku: string | null;
        qtyConsumed: number;
        orderCount: number;
      }
    >();

    for (const r of rows) {
      const key = r.rawMaterialId;
      const cur = aggregated.get(key) ?? {
        rawMaterialId: r.rawMaterialId,
        rawMaterialName: r.rawMaterial.name,
        unit: r.rawMaterial.unit,
        sku: r.rawMaterial.sku,
        qtyConsumed: 0,
        orderCount: 0,
      };
      cur.qtyConsumed += decimalToNumber(r.qtyConsumed);
      cur.orderCount += 1;
      aggregated.set(key, cur);
    }

    return {
      productionEnabled: true,
      rawMaterialsEnabled: true,
      from: formatCalendarDateUtc(from),
      to: formatCalendarDateUtc(to),
      lines: [...aggregated.values()]
        .map((l) => ({ ...l, qtyConsumed: round2(l.qtyConsumed) }))
        .sort((a, b) => b.qtyConsumed - a.qtyConsumed),
      notes: [] as string[],
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
        const data = await this.dailySales(tenantId, {
          date: query.date,
          channel: query.channel,
        });
        if (data.channel === 'orders') {
          const rows: Record<string, unknown>[] = [];
          for (const o of data.orders) {
            for (const item of o.items) {
              rows.push({
                orderId: o.id,
                orderNumber: o.orderNumber,
                status: o.status,
                paymentStatus: o.paymentStatus,
                customer: o.customerName,
                product: item.productName,
                qty: item.quantity,
                qtyDelivered: item.quantityDelivered,
                unitPrice: item.unitPrice,
                lineTotal: item.lineTotal,
                orderTotal: o.total,
                amountPaid: o.amountPaid,
              });
            }
          }
          return {
            title: `Daily Order Sales ${data.date}`,
            headers: [
              'orderId',
              'orderNumber',
              'status',
              'paymentStatus',
              'customer',
              'product',
              'qty',
              'qtyDelivered',
              'unitPrice',
              'lineTotal',
              'orderTotal',
              'amountPaid',
            ],
            rows,
          };
        }
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
          channel: query.channel,
        });
        return {
          title: `Monthly Summary ${query.year}-${String(query.month).padStart(2, '0')} (${data.channel})`,
          headers: ['productId', 'name', 'unitsDelivered', 'revenue', 'cogs', 'grossMargin'],
          rows: data.byProduct as unknown as Record<string, unknown>[],
        };
      }
      case 'product-performance': {
        const data = await this.productPerformance(tenantId, {
          from: query.from,
          to: query.to,
          channel: query.channel,
        });
        return {
          title: `Product Performance ${data.from} to ${data.to} (${data.channel})`,
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
      case 'stock-on-hand': {
        const data = await this.stockOnHand(tenantId, { locationId: query.locationId });
        return {
          title: 'Stock on hand',
          headers: ['kind', 'name', 'sku', 'locationName', 'unit', 'quantity'],
          rows: [
            ...data.finished.map((r) => ({
              kind: 'finished',
              name: r.productName,
              sku: r.sku,
              locationName: r.locationName,
              unit: r.baseUnit,
              quantity: r.quantity,
            })),
            ...data.raw.map((r) => ({
              kind: 'raw',
              name: r.rawMaterialName,
              sku: r.sku,
              locationName: r.locationName,
              unit: r.unit,
              quantity: r.quantity,
            })),
          ],
        };
      }
      case 'purchases-by-vendor': {
        const data = await this.purchasesByVendor(tenantId, {
          from: query.from,
          to: query.to,
          vendorId: query.vendorId,
        });
        return {
          title: `Purchases by vendor ${data.from} to ${data.to}`,
          headers: [
            'vendorName',
            'poCount',
            'poOrderedAmount',
            'billCount',
            'billTotal',
            'billPaid',
            'billOutstanding',
          ],
          rows: data.vendors as unknown as Record<string, unknown>[],
        };
      }
      case 'production-yield': {
        const data = await this.productionYield(tenantId, {
          from: query.from,
          to: query.to,
          productId: query.productId,
        });
        return {
          title: `Production yield ${data.from} to ${data.to}`,
          headers: [
            'productName',
            'plannedQty',
            'actualQty',
            'scrapQty',
            'varianceQty',
            'completedAt',
          ],
          rows: data.orders as unknown as Record<string, unknown>[],
        };
      }
      case 'raw-consumption': {
        const data = await this.rawConsumption(tenantId, {
          from: query.from,
          to: query.to,
          productId: query.productId,
          rawMaterialId: query.rawMaterialId,
        });
        return {
          title: `Raw consumption ${data.from} to ${data.to}`,
          headers: ['rawMaterialName', 'unit', 'qtyConsumed', 'orderCount'],
          rows: data.lines as unknown as Record<string, unknown>[],
        };
      }
      default:
        throw new BadRequestException(
          'type must be one of: daily-sales, monthly-summary, product-performance, customer-outstanding, customer-ledger, container-inventory, rider-collection, expenses, stock-on-hand, purchases-by-vendor, production-yield, raw-consumption',
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
