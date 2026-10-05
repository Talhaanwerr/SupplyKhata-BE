import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import {
  CustomerStatus,
  DeliveryStatus,
  InvoiceLineType,
  InvoicePeriodType,
  InvoiceStatus,
  LedgerEntryType as PrismaLedgerEntryType,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import type { Response } from 'express';
// pdfkit is CommonJS (`export =`); default import compiles to `.default` and breaks at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfkit CJS interop
import PDFDocument = require('pdfkit');
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { assertInvoicesEnabled } from '../common/helpers/invoices.helper';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import {
  endOfZonedDayUtc,
  parseCalendarDateUtc,
  startOfZonedDayUtc,
} from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';
import { PaginationMeta } from '../common/types/api-response.type';
import { GenerateInvoiceDto } from './dto/generate-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

type LineDraft = {
  lineType: InvoiceLineType;
  productId?: string | null;
  description: string;
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  referenceType?: string | null;
  referenceId?: string | null;
  occurredAt?: Date | null;
  sortOrder: number;
};

/** Billable fulfillment statuses for invoice order lines (skip DRAFT/CANCELLED/REFUNDED). */
const BILLABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PLACED,
  OrderStatus.SHIPPED,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];

/**
 * DOCUMENT — Order period filter (v1):
 * Prefer the first OrderStatusEvent where toStatus=PLACED and `at` is in
 * [periodStart, periodEnd] (inclusive, tenant-timezone wall-clock bounds).
 * If no PLACED event exists, fall back to order.createdAt in that range AND
 * status is billable (PLACED | SHIPPED | PARTIALLY_DELIVERED | DELIVERED).
 */
function orderInPeriod(
  order: {
    createdAt: Date;
    status: OrderStatus;
    statusEvents: Array<{ at: Date; toStatus: OrderStatus }>;
  },
  periodStart: Date,
  periodEnd: Date,
): boolean {
  if (!BILLABLE_ORDER_STATUSES.includes(order.status)) return false;
  const placedEvent = order.statusEvents.find((e) => e.toStatus === OrderStatus.PLACED);
  if (placedEvent) {
    return placedEvent.at >= periodStart && placedEvent.at <= periodEnd;
  }
  return order.createdAt >= periodStart && order.createdAt <= periodEnd;
}

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Date-only @db.Date value (UTC noon) for periodStart/periodEnd columns. */
function toDateOnly(isoDate: string): Date {
  const d = parseCalendarDateUtc(isoDate, false);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0));
}

function dateOnlyKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function recomputeHeaderTotals(lines: LineDraft[]): {
  openingBalance: number;
  salesTotal: number;
  deliveriesTotal: number;
  ordersTotal: number;
  paymentsTotal: number;
  adjustmentsTotal: number;
  closingBalance: number;
} {
  let openingBalance = 0;
  let deliveriesTotal = 0;
  let ordersTotal = 0;
  let paymentsAbs = 0;
  let adjustmentsTotal = 0;

  for (const line of lines) {
    switch (line.lineType) {
      case InvoiceLineType.OPENING:
        openingBalance += line.amount;
        break;
      case InvoiceLineType.DELIVERY:
        deliveriesTotal += line.amount;
        break;
      case InvoiceLineType.ORDER:
      case InvoiceLineType.ORDER_FEE:
        ordersTotal += line.amount;
        break;
      case InvoiceLineType.PAYMENT:
        paymentsAbs += Math.abs(line.amount);
        break;
      case InvoiceLineType.ADJUSTMENT:
        adjustmentsTotal += line.amount;
        break;
      default:
        break;
    }
  }

  const salesTotal = round2(deliveriesTotal + ordersTotal);
  const paymentsTotal = round2(paymentsAbs);
  const closingBalance = round2(openingBalance + salesTotal - paymentsTotal + adjustmentsTotal);

  return {
    openingBalance: round2(openingBalance),
    salesTotal,
    deliveriesTotal: round2(deliveriesTotal),
    ordersTotal: round2(ordersTotal),
    paymentsTotal,
    adjustmentsTotal: round2(adjustmentsTotal),
    closingBalance,
  };
}

const userSelect = { id: true, firstName: true, lastName: true, email: true } as const;
const customerSelect = { id: true, name: true, phone: true } as const;

const invoiceInclude = {
  customer: { select: customerSelect },
  createdBy: { select: userSelect },
  issuedBy: { select: userSelect },
  voidedBy: { select: userSelect },
  lines: { orderBy: { sortOrder: 'asc' as const } },
} as const;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async generate(tenantId: string, dto: GenerateInvoiceDto, actorId: string) {
    await assertInvoicesEnabled(this.prisma, tenantId);

    if (dto.periodEnd < dto.periodStart) {
      throw new BadRequestException('periodEnd must be on or after periodStart');
    }

    const tz = await getTenantTimezone(this.prisma, tenantId);
    const periodStartBound = startOfZonedDayUtc(dto.periodStart, tz);
    const periodEndBound = endOfZonedDayUtc(dto.periodEnd, tz);
    const periodStartDate = toDateOnly(dto.periodStart);
    const periodEndDate = toDateOnly(dto.periodEnd);

    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, tenantId, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.status !== CustomerStatus.ACTIVE) {
      throw new BadRequestException('Customer must be ACTIVE to generate an invoice');
    }

    await this.assertNoOverlappingIssued(tenantId, dto.customerId, periodStartDate, periodEndDate);

    const settings = await this.prisma.tenantSettings.findUnique({ where: { tenantId } });
    const currency = settings?.currency ?? 'USD';

    const openingBalance = await this.computeOpeningBalance(
      tenantId,
      dto.customerId,
      periodStartBound,
    );

    const lines: LineDraft[] = [];
    let sortOrder = 0;

    lines.push({
      lineType: InvoiceLineType.OPENING,
      description: 'Opening balance',
      amount: openingBalance,
      referenceType: 'ledger',
      sortOrder: sortOrder++,
    });

    // Deliveries: non-cancelled, deliveryDate in period
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        tenantId,
        customerId: dto.customerId,
        status: { not: DeliveryStatus.CANCELLED },
        deliveryDate: { gte: periodStartBound, lte: periodEndBound },
      },
      include: {
        items: { include: { product: { select: { id: true, name: true } } } },
      },
      orderBy: { deliveryDate: 'asc' },
    });

    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        lines.push({
          lineType: InvoiceLineType.DELIVERY,
          productId: item.productId,
          description: item.product.name,
          quantity: decimalToNumber(item.quantityDelivered),
          unitPrice: decimalToNumber(item.sellingPriceSnapshot),
          amount: decimalToNumber(item.lineTotal),
          referenceType: 'delivery',
          referenceId: delivery.id,
          occurredAt: delivery.deliveryDate,
          sortOrder: sortOrder++,
        });
      }
    }

    // Orders — see orderInPeriod DOCUMENT comment above
    const orders = await this.prisma.customerOrder.findMany({
      where: {
        tenantId,
        customerId: dto.customerId,
        deletedAt: null,
        status: { in: BILLABLE_ORDER_STATUSES },
      },
      include: {
        items: { include: { product: { select: { id: true, name: true } } } },
        statusEvents: {
          where: { toStatus: OrderStatus.PLACED },
          orderBy: { at: 'asc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const order of orders) {
      if (!orderInPeriod(order, periodStartBound, periodEndBound)) continue;

      const placedAt = order.statusEvents[0]?.at ?? order.createdAt;
      for (const item of order.items) {
        lines.push({
          lineType: InvoiceLineType.ORDER,
          productId: item.productId,
          description: `${item.product.name} (Order #${order.orderNumber})`,
          quantity: decimalToNumber(item.quantity),
          unitPrice: decimalToNumber(item.unitPriceSnapshot),
          amount: decimalToNumber(item.lineTotal),
          referenceType: 'order',
          referenceId: order.id,
          occurredAt: placedAt,
          sortOrder: sortOrder++,
        });
      }

      const fee = decimalToNumber(order.deliveryCharges);
      if (fee > 0) {
        lines.push({
          lineType: InvoiceLineType.ORDER_FEE,
          description: `Delivery charges (Order #${order.orderNumber})`,
          amount: fee,
          referenceType: 'order',
          referenceId: order.id,
          occurredAt: placedAt,
          sortOrder: sortOrder++,
        });
      }
    }

    // Payments + in-period adjustments from ledger (not Payment table alone).
    // Delivery cash-on-delivery posts ledger PAYMENT with referenceType "delivery"
    // and does NOT create a Payment row — Payment.findMany would miss those.
    // Standalone payments post both Payment + ledger PAYMENT; use ledger only to avoid double-count.
    const periodLedger = await this.prisma.customerLedgerEntry.findMany({
      where: {
        tenantId,
        customerId: dto.customerId,
        createdAt: { gte: periodStartBound, lte: periodEndBound },
        entryType: {
          in: [
            PrismaLedgerEntryType.PAYMENT,
            PrismaLedgerEntryType.OPENING_BALANCE,
            PrismaLedgerEntryType.ADJUSTMENT,
            PrismaLedgerEntryType.REFUND,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const entry of periodLedger) {
      const amt = decimalToNumber(entry.amount);
      if (entry.entryType === PrismaLedgerEntryType.PAYMENT) {
        lines.push({
          lineType: InvoiceLineType.PAYMENT,
          description: entry.notes?.trim() || 'Payment',
          amount: amt, // already negative credit on ledger
          referenceType: entry.referenceType ?? 'ledger',
          referenceId: entry.referenceId ?? entry.id,
          occurredAt: entry.createdAt,
          sortOrder: sortOrder++,
        });
        continue;
      }
      // OPENING_BALANCE / ADJUSTMENT / REFUND posted during the period (not before start)
      lines.push({
        lineType: InvoiceLineType.ADJUSTMENT,
        description:
          entry.notes?.trim() ||
          (entry.entryType === PrismaLedgerEntryType.OPENING_BALANCE
            ? 'Opening receivable (in period)'
            : entry.entryType === PrismaLedgerEntryType.REFUND
              ? 'Refund'
              : 'Adjustment'),
        amount: amt,
        referenceType: entry.referenceType ?? 'ledger',
        referenceId: entry.referenceId ?? entry.id,
        occurredAt: entry.createdAt,
        sortOrder: sortOrder++,
      });
    }

    // POS hook (when POS ships): include PosSale lines if pos flag ON — not implemented yet.

    const totals = recomputeHeaderTotals(lines);

    const invoice = await this.prisma.$transaction(async (tx) => {
      // Replace exact same customer + periodStart + periodEnd DRAFT
      const existingDrafts = await tx.customerInvoice.findMany({
        where: {
          tenantId,
          customerId: dto.customerId,
          status: InvoiceStatus.DRAFT,
        },
        select: { id: true, periodStart: true, periodEnd: true },
      });
      const toReplace = existingDrafts.filter(
        (d) =>
          dateOnlyKey(d.periodStart) === dateOnlyKey(periodStartDate) &&
          dateOnlyKey(d.periodEnd) === dateOnlyKey(periodEndDate),
      );
      if (toReplace.length > 0) {
        await tx.customerInvoice.deleteMany({
          where: { id: { in: toReplace.map((d) => d.id) }, tenantId },
        });
      }

      return tx.customerInvoice.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          invoiceNumber: null,
          periodStart: periodStartDate,
          periodEnd: periodEndDate,
          periodType: dto.periodType,
          status: InvoiceStatus.DRAFT,
          currency,
          openingBalance: new Prisma.Decimal(totals.openingBalance),
          salesTotal: new Prisma.Decimal(totals.salesTotal),
          deliveriesTotal: new Prisma.Decimal(totals.deliveriesTotal),
          ordersTotal: new Prisma.Decimal(totals.ordersTotal),
          paymentsTotal: new Prisma.Decimal(totals.paymentsTotal),
          adjustmentsTotal: new Prisma.Decimal(totals.adjustmentsTotal),
          closingBalance: new Prisma.Decimal(totals.closingBalance),
          notes: dto.notes?.trim() || null,
          createdById: actorId,
          lines: {
            create: lines.map((l) => ({
              tenantId,
              lineType: l.lineType,
              productId: l.productId ?? null,
              description: l.description,
              quantity: l.quantity != null ? new Prisma.Decimal(l.quantity) : null,
              unitPrice: l.unitPrice != null ? new Prisma.Decimal(l.unitPrice) : null,
              amount: new Prisma.Decimal(l.amount),
              referenceType: l.referenceType ?? null,
              referenceId: l.referenceId ?? null,
              occurredAt: l.occurredAt ?? null,
              sortOrder: l.sortOrder,
            })),
          },
        },
        include: invoiceInclude,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'invoices',
      action: 'GENERATE',
      entityId: invoice.id,
      newValue: {
        customerId: dto.customerId,
        periodType: dto.periodType,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        openingBalance: totals.openingBalance,
        salesTotal: totals.salesTotal,
        paymentsTotal: totals.paymentsTotal,
        closingBalance: totals.closingBalance,
        lineCount: lines.length,
      },
    });

    return this.toDetail(invoice);
  }

  async list(
    tenantId: string,
    query: ListInvoicesQueryDto,
  ): Promise<{ items: ReturnType<InvoicesService['toListItem']>[]; meta: PaginationMeta }> {
    await assertInvoicesEnabled(this.prisma, tenantId);
    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(tenantId, query);

    const [rows, total] = await Promise.all([
      this.prisma.customerInvoice.findMany({
        where,
        skip,
        take,
        orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        include: {
          customer: { select: customerSelect },
          createdBy: { select: userSelect },
        },
      }),
      this.prisma.customerInvoice.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItem(r)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async listForCustomer(customerId: string, tenantId: string, query: ListInvoicesQueryDto) {
    await assertInvoicesEnabled(this.prisma, tenantId);
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return this.list(tenantId, { ...query, customerId });
  }

  async findOne(id: string, tenantId: string) {
    await assertInvoicesEnabled(this.prisma, tenantId);
    const invoice = await this.prisma.customerInvoice.findFirst({
      where: { id, tenantId },
      include: invoiceInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return this.toDetail(invoice);
  }

  async issue(id: string, tenantId: string, actorId: string) {
    await assertInvoicesEnabled(this.prisma, tenantId);

    const invoice = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerInvoice.findFirst({
        where: { id, tenantId },
        include: invoiceInclude,
      });
      if (!existing) throw new NotFoundException('Invoice not found');
      if (existing.status !== InvoiceStatus.DRAFT) {
        throw new BadRequestException('Only DRAFT invoices can be issued');
      }

      await this.assertNoOverlappingIssued(
        tenantId,
        existing.customerId,
        existing.periodStart,
        existing.periodEnd,
        existing.id,
        tx,
      );

      const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
      if (!settings) throw new BadRequestException('Tenant settings not found');

      const nextSeq = settings.lastInvoiceSeq + 1;
      const prefix = settings.invoicePrefix || 'INV';
      const invoiceNumber = `${prefix}${String(nextSeq).padStart(6, '0')}`;

      await tx.tenantSettings.update({
        where: { tenantId },
        data: { lastInvoiceSeq: nextSeq },
      });

      return tx.customerInvoice.update({
        where: { id },
        data: {
          status: InvoiceStatus.ISSUED,
          invoiceNumber,
          issuedAt: new Date(),
          issuedById: actorId,
        },
        include: invoiceInclude,
      });
    });

    // NO ledger writes on issue — invoice is a document only.

    await this.audit.write({
      tenantId,
      actorId,
      module: 'invoices',
      action: 'ISSUE',
      entityId: invoice.id,
      newValue: {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        issuedAt: invoice.issuedAt?.toISOString(),
      },
    });

    return this.toDetail(invoice);
  }

  async voidInvoice(id: string, tenantId: string, dto: VoidInvoiceDto, actorId: string) {
    await assertInvoicesEnabled(this.prisma, tenantId);

    const existing = await this.prisma.customerInvoice.findFirst({
      where: { id, tenantId },
      include: invoiceInclude,
    });
    if (!existing) throw new NotFoundException('Invoice not found');
    if (existing.status !== InvoiceStatus.ISSUED) {
      throw new BadRequestException('Only ISSUED invoices can be voided');
    }

    const invoice = await this.prisma.customerInvoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.VOID,
        voidedAt: new Date(),
        voidedById: actorId,
        voidReason: dto.reason.trim(),
      },
      include: invoiceInclude,
    });

    // NO ledger writes on void — document status only.

    await this.audit.write({
      tenantId,
      actorId,
      module: 'invoices',
      action: 'VOID',
      entityId: invoice.id,
      oldValue: { status: InvoiceStatus.ISSUED, invoiceNumber: existing.invoiceNumber },
      newValue: {
        status: InvoiceStatus.VOID,
        voidReason: dto.reason.trim(),
        voidedAt: invoice.voidedAt?.toISOString(),
      },
    });

    return this.toDetail(invoice);
  }

  async removeDraft(id: string, tenantId: string, actorId: string) {
    await assertInvoicesEnabled(this.prisma, tenantId);

    const existing = await this.prisma.customerInvoice.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException('Invoice not found');
    if (existing.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT invoices can be deleted');
    }

    await this.prisma.customerInvoice.delete({ where: { id } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'invoices',
      action: 'DELETE',
      entityId: id,
      oldValue: {
        status: existing.status,
        customerId: existing.customerId,
        periodStart: dateOnlyKey(existing.periodStart),
        periodEnd: dateOnlyKey(existing.periodEnd),
      },
    });
  }

  async pdf(id: string, tenantId: string, res: Response): Promise<StreamableFile> {
    await assertInvoicesEnabled(this.prisma, tenantId);

    const invoice = await this.prisma.customerInvoice.findFirst({
      where: { id, tenantId },
      include: invoiceInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === InvoiceStatus.VOID) {
      throw new BadRequestException('Cannot download PDF for a voided invoice');
    }

    const settings = await this.prisma.tenantSettings.findUnique({ where: { tenantId } });
    const buffer = await this.buildInvoicePdf(invoice, settings);
    const label = invoice.invoiceNumber ?? `draft-${invoice.id.slice(0, 8)}`;
    const filename = `invoice-${label}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });
    return new StreamableFile(buffer);
  }

  // ─── internals ──────────────────────────────────────────────

  private async computeOpeningBalance(
    tenantId: string,
    customerId: string,
    periodStart: Date,
  ): Promise<number> {
    const agg = await this.prisma.customerLedgerEntry.aggregate({
      where: {
        tenantId,
        customerId,
        createdAt: { lt: periodStart },
      },
      _sum: { amount: true },
    });
    return round2(decimalToNumber(agg._sum.amount));
  }

  private async assertNoOverlappingIssued(
    tenantId: string,
    customerId: string,
    periodStart: Date,
    periodEnd: Date,
    excludeInvoiceId?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const issued = await db.customerInvoice.findMany({
      where: {
        tenantId,
        customerId,
        status: InvoiceStatus.ISSUED,
        ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      },
      select: { id: true, invoiceNumber: true, periodStart: true, periodEnd: true },
    });

    const startKey = dateOnlyKey(periodStart);
    const endKey = dateOnlyKey(periodEnd);

    const overlap = issued.find((inv) => {
      const a = dateOnlyKey(inv.periodStart);
      const b = dateOnlyKey(inv.periodEnd);
      return startKey <= b && endKey >= a;
    });

    if (overlap) {
      throw new BadRequestException(
        `Overlapping ISSUED invoice ${overlap.invoiceNumber ?? overlap.id} covers this period. Void it first.`,
      );
    }
  }

  private buildWhere(
    tenantId: string,
    query: ListInvoicesQueryDto,
  ): Prisma.CustomerInvoiceWhereInput {
    const where: Prisma.CustomerInvoiceWhereInput = { tenantId };
    if (query.customerId) where.customerId = query.customerId;
    if (query.status) where.status = query.status;
    if (query.dateFrom || query.dateTo) {
      where.AND = [];
      if (query.dateFrom) {
        (where.AND as Prisma.CustomerInvoiceWhereInput[]).push({
          periodStart: { gte: toDateOnly(query.dateFrom) },
        });
      }
      if (query.dateTo) {
        (where.AND as Prisma.CustomerInvoiceWhereInput[]).push({
          periodEnd: { lte: toDateOnly(query.dateTo) },
        });
      }
    }
    return where;
  }

  private buildInvoicePdf(
    invoice: {
      invoiceNumber: string | null;
      status: InvoiceStatus;
      periodType: InvoicePeriodType;
      periodStart: Date;
      periodEnd: Date;
      currency: string;
      openingBalance: DecimalLike;
      salesTotal: DecimalLike;
      deliveriesTotal: DecimalLike;
      ordersTotal: DecimalLike;
      paymentsTotal: DecimalLike;
      adjustmentsTotal: DecimalLike;
      closingBalance: DecimalLike;
      notes: string | null;
      customer: { name: string; phone: string };
      lines: Array<{
        lineType: InvoiceLineType;
        description: string;
        quantity: DecimalLike;
        unitPrice: DecimalLike;
        amount: DecimalLike;
        occurredAt: Date | null;
      }>;
    },
    settings: {
      orgName: string | null;
      invoicePrefix: string;
      currency: string;
      phone: string | null;
      address: string | null;
    } | null,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const org = settings?.orgName?.trim() || 'SupplyKhata';
      const currency = invoice.currency || settings?.currency || 'USD';
      const title =
        invoice.status === InvoiceStatus.DRAFT
          ? 'DRAFT INVOICE'
          : `Invoice ${invoice.invoiceNumber ?? ''}`;

      doc.fontSize(18).text(org, { align: 'left' });
      if (settings?.phone) doc.fontSize(9).fillColor('#555').text(settings.phone);
      if (settings?.address) doc.fontSize(9).fillColor('#555').text(settings.address);
      doc.fillColor('#000').moveDown(0.5);
      doc.fontSize(14).text(title, { underline: true });

      if (invoice.status === InvoiceStatus.DRAFT) {
        doc.fontSize(10).fillColor('#b45309').text('DRAFT — not issued', { align: 'right' });
        doc.fillColor('#000');
      }

      doc.moveDown(0.5);
      doc.fontSize(10);
      doc.text(`Customer: ${invoice.customer.name}`);
      doc.text(`Phone: ${invoice.customer.phone}`);
      doc.text(
        `Period (${invoice.periodType}): ${dateOnlyKey(invoice.periodStart)} → ${dateOnlyKey(invoice.periodEnd)}`,
      );
      doc.text(`Currency: ${currency}`);
      if (settings?.invoicePrefix) {
        doc.text(`Invoice prefix: ${settings.invoicePrefix}`);
      }
      doc.moveDown();

      const money = (n: number) =>
        `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      doc.fontSize(11).text('Summary', { underline: true });
      doc.fontSize(10);
      doc.text(`Opening balance: ${money(decimalToNumber(invoice.openingBalance))}`);
      doc.text(`Deliveries: ${money(decimalToNumber(invoice.deliveriesTotal))}`);
      doc.text(`Orders: ${money(decimalToNumber(invoice.ordersTotal))}`);
      doc.text(`Sales total: ${money(decimalToNumber(invoice.salesTotal))}`);
      doc.text(`Payments: ${money(decimalToNumber(invoice.paymentsTotal))}`);
      doc.text(`Adjustments: ${money(decimalToNumber(invoice.adjustmentsTotal))}`);
      doc.fontSize(11).text(`Closing balance: ${money(decimalToNumber(invoice.closingBalance))}`);
      doc.moveDown();

      doc.fontSize(11).text('Lines', { underline: true });
      doc.fontSize(9);
      for (const line of invoice.lines) {
        const qty = line.quantity != null ? ` qty ${decimalToNumber(line.quantity)}` : '';
        const when = line.occurredAt ? ` [${dateOnlyKey(line.occurredAt)}]` : '';
        doc.text(
          `${line.lineType} | ${line.description}${qty}${when} | ${money(decimalToNumber(line.amount))}`,
          { lineBreak: true },
        );
      }

      if (invoice.notes) {
        doc.moveDown().fontSize(10).text(`Notes: ${invoice.notes}`);
      }

      doc.moveDown().fontSize(8).fillColor('#666').text('Document only — does not post ledger.');
      doc.end();
    });
  }

  private toListItem(row: {
    id: string;
    tenantId: string;
    customerId: string;
    invoiceNumber: string | null;
    periodStart: Date;
    periodEnd: Date;
    periodType: InvoicePeriodType;
    status: InvoiceStatus;
    currency: string;
    openingBalance: DecimalLike;
    salesTotal: DecimalLike;
    deliveriesTotal: DecimalLike;
    ordersTotal: DecimalLike;
    paymentsTotal: DecimalLike;
    adjustmentsTotal: DecimalLike;
    closingBalance: DecimalLike;
    issuedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    customer: { id: string; name: string; phone: string };
    createdBy: { id: string; firstName: string; lastName: string; email: string };
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      invoiceNumber: row.invoiceNumber,
      periodStart: dateOnlyKey(row.periodStart),
      periodEnd: dateOnlyKey(row.periodEnd),
      periodType: row.periodType,
      status: row.status,
      currency: row.currency,
      openingBalance: decimalToNumber(row.openingBalance),
      salesTotal: decimalToNumber(row.salesTotal),
      deliveriesTotal: decimalToNumber(row.deliveriesTotal),
      ordersTotal: decimalToNumber(row.ordersTotal),
      paymentsTotal: decimalToNumber(row.paymentsTotal),
      adjustmentsTotal: decimalToNumber(row.adjustmentsTotal),
      closingBalance: decimalToNumber(row.closingBalance),
      issuedAt: row.issuedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      customer: row.customer,
      createdBy: row.createdBy,
    };
  }

  private toDetail(row: {
    id: string;
    tenantId: string;
    customerId: string;
    invoiceNumber: string | null;
    periodStart: Date;
    periodEnd: Date;
    periodType: InvoicePeriodType;
    status: InvoiceStatus;
    currency: string;
    openingBalance: DecimalLike;
    salesTotal: DecimalLike;
    deliveriesTotal: DecimalLike;
    ordersTotal: DecimalLike;
    paymentsTotal: DecimalLike;
    adjustmentsTotal: DecimalLike;
    closingBalance: DecimalLike;
    issuedAt: Date | null;
    issuedById: string | null;
    voidedAt: Date | null;
    voidedById: string | null;
    voidReason: string | null;
    notes: string | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    customer: { id: string; name: string; phone: string };
    createdBy: { id: string; firstName: string; lastName: string; email: string };
    issuedBy: { id: string; firstName: string; lastName: string; email: string } | null;
    voidedBy: { id: string; firstName: string; lastName: string; email: string } | null;
    lines: Array<{
      id: string;
      lineType: InvoiceLineType;
      productId: string | null;
      description: string;
      quantity: DecimalLike;
      unitPrice: DecimalLike;
      amount: DecimalLike;
      referenceType: string | null;
      referenceId: string | null;
      occurredAt: Date | null;
      sortOrder: number;
    }>;
  }) {
    return {
      ...this.toListItem(row),
      issuedById: row.issuedById,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedById: row.voidedById,
      voidReason: row.voidReason,
      notes: row.notes,
      createdById: row.createdById,
      issuedBy: row.issuedBy,
      voidedBy: row.voidedBy,
      lines: row.lines.map((l) => ({
        id: l.id,
        lineType: l.lineType,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity != null ? decimalToNumber(l.quantity) : null,
        unitPrice: l.unitPrice != null ? decimalToNumber(l.unitPrice) : null,
        amount: decimalToNumber(l.amount),
        referenceType: l.referenceType,
        referenceId: l.referenceId,
        occurredAt: l.occurredAt?.toISOString() ?? null,
        sortOrder: l.sortOrder,
      })),
    };
  }
}
