import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VendorBillStatus, VendorLedgerEntryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import {
  assertVendorBillsEnabled,
  isVendorBillsEnabled,
} from '../common/helpers/vendor-bills.helper';
import {
  CreateVendorBillDto,
  ListVendorBillsQueryDto,
  ListVendorDuesQueryDto,
  ListVendorLedgerQueryDto,
  PayVendorBillDto,
  VoidVendorBillDto,
} from './dto/vendor-bill.dto';
import { parseCalendarDateUtc, todayYmdInTimeZone } from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function parseDate(value: string): Date {
  const parsed = parseCalendarDateUtc(value, false);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return parsed;
}

function endOfDay(value: string): Date {
  const d = parseCalendarDateUtc(value, true);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return d;
}

function roundMoney(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n.toFixed(2));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signedLedgerAmount(entryType: VendorLedgerEntryType, amount: DecimalLike): number {
  const abs = decimalToNumber(amount);
  if (entryType === VendorLedgerEntryType.BILL) return abs;
  // PAYMENT and VOID reduce what we owe
  return -abs;
}

function parseCalendarOrIso(value: string): Date {
  return parseDate(value);
}

/**
 * Vendor bills / payables. Never touches customer ledger or DeliveryRunStock.
 */
@Injectable()
export class VendorBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(tenantId: string, query: ListVendorBillsQueryDto) {
    await assertVendorBillsEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const where: Prisma.VendorBillWhereInput = {
      tenantId,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
      ...(query.goodsReceiptId ? { goodsReceiptId: query.goodsReceiptId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search?.trim() ? { billNumber: { contains: query.search.trim() } } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            billDate: {
              ...(query.dateFrom ? { gte: parseDate(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.vendorBill.findMany({
        where,
        skip,
        take,
        orderBy: { billDate: 'desc' },
        include: {
          vendor: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.vendorBill.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.mapBill(r)),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertVendorBillsEnabled(this.prisma, tenantId);
    const bill = await this.requireBill(tenantId, id, true);
    return this.mapDetail(bill);
  }

  async create(tenantId: string, dto: CreateVendorBillDto, actorId: string) {
    await assertVendorBillsEnabled(this.prisma, tenantId);

    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, tenantId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (!vendor.isActive) throw new BadRequestException('Vendor is inactive');

    if (dto.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: dto.purchaseOrderId, tenantId, vendorId: dto.vendorId },
      });
      if (!po) throw new BadRequestException('Purchase order not found for this vendor');
    }
    if (dto.goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findFirst({
        where: { id: dto.goodsReceiptId, tenantId },
        include: { purchaseOrder: true },
      });
      if (!grn) throw new BadRequestException('Goods receipt not found');
      if (grn.purchaseOrder.vendorId !== dto.vendorId) {
        throw new BadRequestException('Goods receipt does not belong to this vendor');
      }
      const alreadyBilled = await this.prisma.vendorBill.findFirst({
        where: {
          tenantId,
          goodsReceiptId: dto.goodsReceiptId,
          status: { not: VendorBillStatus.VOID },
        },
        select: { id: true, billNumber: true },
      });
      if (alreadyBilled) {
        throw new BadRequestException(
          `Goods receipt already has bill ${alreadyBilled.billNumber || alreadyBilled.id}`,
        );
      }
    }

    const lines = dto.lines.map((l, idx) => {
      const amount = roundMoney(l.qty * l.unitCost);
      return {
        lineNo: idx + 1,
        description: l.description.trim(),
        qty: new Prisma.Decimal(l.qty),
        unitCost: roundMoney(l.unitCost),
        amount,
        purchaseOrderLineId: l.purchaseOrderLineId || null,
        goodsReceiptLineId: l.goodsReceiptLineId || null,
      };
    });
    const totalAmount = lines.reduce((sum, l) => sum.add(l.amount), new Prisma.Decimal(0));
    if (totalAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Bill total must be greater than 0');
    }

    const bill = await this.prisma.$transaction(async (tx) => {
      const billNumber = await this.nextBillNumber(tx, tenantId);
      const created = await tx.vendorBill.create({
        data: {
          tenantId,
          vendorId: dto.vendorId,
          purchaseOrderId: dto.purchaseOrderId || null,
          goodsReceiptId: dto.goodsReceiptId || null,
          billNumber,
          billDate: parseDate(dto.billDate),
          dueDate: dto.dueDate ? parseDate(dto.dueDate) : null,
          notes: dto.notes?.trim() || null,
          status: VendorBillStatus.UNPAID,
          totalAmount,
          paidAmount: new Prisma.Decimal(0),
          createdByUserId: actorId,
          lines: {
            create: lines.map((l) => ({
              tenantId,
              ...l,
            })),
          },
        },
        include: {
          vendor: { select: { id: true, name: true, phone: true } },
          lines: { orderBy: { lineNo: 'asc' } },
          payments: true,
        },
      });

      await tx.vendorLedgerEntry.create({
        data: {
          tenantId,
          vendorId: dto.vendorId,
          entryType: VendorLedgerEntryType.BILL,
          amount: totalAmount,
          referenceType: 'VendorBill',
          referenceId: created.id,
          notes: `Bill ${billNumber}`,
        },
      });

      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendor-bills',
      action: 'CREATE',
      entityId: bill.id,
      newValue: {
        billNumber: bill.billNumber,
        vendorId: bill.vendorId,
        totalAmount: decimalToNumber(bill.totalAmount),
      },
    });

    return this.mapDetail(bill);
  }

  async pay(id: string, tenantId: string, dto: PayVendorBillDto, actorId: string) {
    await assertVendorBillsEnabled(this.prisma, tenantId);
    const bill = await this.requireBill(tenantId, id, true);

    if (bill.status === VendorBillStatus.VOID || bill.status === VendorBillStatus.PAID) {
      throw new BadRequestException('This bill cannot accept payments');
    }

    const remaining = new Prisma.Decimal(bill.totalAmount).sub(bill.paidAmount);
    const payAmt = roundMoney(dto.amount);
    if (payAmt.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Payment amount must be greater than 0');
    }
    if (payAmt.greaterThan(remaining)) {
      throw new BadRequestException(`Payment exceeds remaining payable (${remaining.toString()})`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.vendorBillPayment.create({
        data: {
          tenantId,
          vendorBillId: id,
          vendorId: bill.vendorId,
          amount: payAmt,
          paymentDate: parseDate(dto.paymentDate),
          method: dto.method,
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          createdByUserId: actorId,
        },
      });

      await tx.vendorLedgerEntry.create({
        data: {
          tenantId,
          vendorId: bill.vendorId,
          entryType: VendorLedgerEntryType.PAYMENT,
          amount: payAmt,
          referenceType: 'VendorBill',
          referenceId: id,
          notes: dto.reference?.trim() || null,
        },
      });

      const newPaid = new Prisma.Decimal(bill.paidAmount).add(payAmt);
      const status = newPaid.greaterThanOrEqualTo(bill.totalAmount)
        ? VendorBillStatus.PAID
        : VendorBillStatus.PARTIALLY_PAID;

      return tx.vendorBill.update({
        where: { id },
        data: { paidAmount: newPaid, status },
        include: {
          vendor: { select: { id: true, name: true, phone: true } },
          lines: { orderBy: { lineNo: 'asc' } },
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendor-bills',
      action: 'PAY',
      entityId: id,
      newValue: {
        amount: decimalToNumber(payAmt),
        method: dto.method,
        status: updated.status,
      },
    });

    return this.mapDetail(updated);
  }

  async setDueDate(id: string, tenantId: string, dueDate: string, actorId: string) {
    await assertVendorBillsEnabled(this.prisma, tenantId);
    const bill = await this.requireBill(tenantId, id, false);
    if (bill.status === VendorBillStatus.VOID || bill.status === VendorBillStatus.PAID) {
      throw new BadRequestException('Cannot change due date on this bill');
    }
    const parsed = parseDate(dueDate);
    await this.prisma.vendorBill.update({
      where: { id },
      data: { dueDate: parsed },
    });
    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendor-bills',
      action: 'UPDATE',
      entityId: id,
      newValue: { dueDate: parsed.toISOString() },
    });
    return this.findOne(id, tenantId);
  }

  async void(id: string, tenantId: string, dto: VoidVendorBillDto, actorId: string) {
    await assertVendorBillsEnabled(this.prisma, tenantId);
    const bill = await this.requireBill(tenantId, id, true);

    if (bill.status === VendorBillStatus.VOID) {
      throw new BadRequestException('Bill is already void');
    }
    if (new Prisma.Decimal(bill.paidAmount).greaterThan(0)) {
      throw new BadRequestException('Cannot void a bill that has payments');
    }
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('Void reason is required');

    const updated = await this.prisma.$transaction(async (tx) => {
      const voided = await tx.vendorBill.update({
        where: { id },
        data: { status: VendorBillStatus.VOID, voidReason: reason },
        include: {
          vendor: { select: { id: true, name: true, phone: true } },
          lines: { orderBy: { lineNo: 'asc' } },
          payments: true,
        },
      });

      await tx.vendorLedgerEntry.create({
        data: {
          tenantId,
          vendorId: bill.vendorId,
          entryType: VendorLedgerEntryType.VOID,
          amount: bill.totalAmount,
          referenceType: 'VendorBill',
          referenceId: id,
          notes: reason,
        },
      });

      return voided;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'vendor-bills',
      action: 'VOID',
      entityId: id,
      newValue: { voidReason: reason },
    });

    return this.mapDetail(updated);
  }

  /**
   * Build unpaid bill from a goods receipt (qty × PO unit cost).
   * Idempotent: returns existing non-void bill for the same GRN.
   */
  async createFromGoodsReceipt(
    tenantId: string,
    goodsReceiptId: string,
    actorId: string,
    opts?: { dueDate?: string | null },
  ) {
    await assertVendorBillsEnabled(this.prisma, tenantId);

    const existing = await this.prisma.vendorBill.findFirst({
      where: {
        tenantId,
        goodsReceiptId,
        status: { not: VendorBillStatus.VOID },
      },
      select: { id: true },
    });
    if (existing) {
      // Allow setting due date on an existing auto-bill that has none yet.
      if (opts?.dueDate && !Number.isNaN(parseCalendarOrIso(opts.dueDate).getTime())) {
        const bill = await this.prisma.vendorBill.findFirst({
          where: { id: existing.id, tenantId },
        });
        if (bill && !bill.dueDate) {
          await this.prisma.vendorBill.update({
            where: { id: existing.id },
            data: { dueDate: parseDate(opts.dueDate) },
          });
        }
      }
      return this.findOne(existing.id, tenantId);
    }

    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: goodsReceiptId, tenantId },
      include: {
        purchaseOrder: { select: { id: true, vendorId: true, poNumber: true } },
        lines: {
          include: {
            purchaseOrderLine: {
              include: {
                product: { select: { id: true, name: true } },
                rawMaterial: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (!grn.lines.length) {
      throw new BadRequestException('Goods receipt has no lines to bill');
    }

    const billDate = grn.receiptDate.toISOString().slice(0, 10);
    const dueDate = opts?.dueDate?.trim() || billDate;
    const lines = grn.lines.map((l) => {
      const poLine = l.purchaseOrderLine;
      const name = poLine.product?.name || poLine.rawMaterial?.name || `PO line #${poLine.lineNo}`;
      return {
        description: name,
        qty: decimalToNumber(l.qtyReceived),
        unitCost: decimalToNumber(poLine.unitCost),
        purchaseOrderLineId: l.purchaseOrderLineId,
        goodsReceiptLineId: l.id,
      };
    });

    return this.create(
      tenantId,
      {
        vendorId: grn.purchaseOrder.vendorId,
        billDate,
        dueDate,
        purchaseOrderId: grn.purchaseOrderId,
        goodsReceiptId: grn.id,
        notes: `From goods receipt · ${grn.purchaseOrder.poNumber || 'PO'}`,
        lines,
      },
      actorId,
    );
  }

  /** Billed / paid / open totals for a vendor (non-void bills). */
  async payablesSummary(tenantId: string, vendorId: string) {
    if (!(await isVendorBillsEnabled(this.prisma, tenantId))) {
      return { billedTotal: 0, paidTotal: 0, openTotal: 0 };
    }

    const bills = await this.prisma.vendorBill.findMany({
      where: {
        tenantId,
        vendorId,
        status: { not: VendorBillStatus.VOID },
      },
      select: { totalAmount: true, paidAmount: true, status: true },
    });

    let billedTotal = 0;
    let paidTotal = 0;
    let openTotal = 0;
    for (const b of bills) {
      const total = decimalToNumber(b.totalAmount);
      const paid = decimalToNumber(b.paidAmount);
      billedTotal += total;
      paidTotal += paid;
      if (b.status === VendorBillStatus.UNPAID || b.status === VendorBillStatus.PARTIALLY_PAID) {
        openTotal += Math.max(0, total - paid);
      }
    }

    return {
      billedTotal: round2(billedTotal),
      paidTotal: round2(paidTotal),
      openTotal: round2(openTotal),
    };
  }

  /** Outstanding payables for a vendor (used by VendorsService). */
  async openPayablesTotal(tenantId: string, vendorId: string): Promise<number> {
    const summary = await this.payablesSummary(tenantId, vendorId);
    return summary.openTotal;
  }

  /**
   * Vendor ledger (BILL ↑ payable, PAYMENT/VOID ↓).
   * Running balance = amount still owed.
   */
  async listLedger(tenantId: string, vendorId: string, query: ListVendorLedgerQueryDto) {
    await assertVendorBillsEnabled(this.prisma, tenantId);

    const vendor = await this.prisma.vendor.findFirst({
      where: { id: vendorId, tenantId },
      select: { id: true, name: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const from = query.from ? parseDate(query.from) : null;
    const to = query.to ? endOfDay(query.to) : null;

    let openingBalance = 0;
    if (from) {
      const before = await this.prisma.vendorLedgerEntry.findMany({
        where: { tenantId, vendorId, createdAt: { lt: from } },
        select: { entryType: true, amount: true },
      });
      openingBalance = before.reduce(
        (sum, e) => sum + signedLedgerAmount(e.entryType, e.amount),
        0,
      );
    }

    const where: Prisma.VendorLedgerEntryWhereInput = {
      tenantId,
      vendorId,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const allInScope = await this.prisma.vendorLedgerEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    let running = openingBalance;
    const withBalance = allInScope.map((entry) => {
      const signed = signedLedgerAmount(entry.entryType, entry.amount);
      running += signed;
      return {
        id: entry.id,
        entryType: entry.entryType,
        amount: Math.abs(signed),
        signedAmount: round2(signed),
        debit: signed > 0 ? round2(signed) : 0,
        credit: signed < 0 ? round2(-signed) : 0,
        runningBalance: round2(running),
        notes: entry.notes,
        referenceId: entry.referenceId,
        referenceType: entry.referenceType,
        createdAt: entry.createdAt,
      };
    });

    const { skip, take } = getPaginationParams(query);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const newestFirst = [...withBalance].reverse();
    const pageItems = newestFirst.slice(skip, skip + take);
    const summary = await this.payablesSummary(tenantId, vendorId);

    return {
      vendorId,
      vendorName: vendor.name,
      openingBalance: round2(openingBalance),
      summary,
      items: pageItems,
      meta: buildPaginationMeta(withBalance.length, page, limit),
    };
  }

  /**
   * Bills due on or before `date` (default today), plus open bills with no due date.
   * Grouped by vendor for the daily payables screen.
   */
  async listDues(tenantId: string, query: ListVendorDuesQueryDto) {
    await assertVendorBillsEnabled(this.prisma, tenantId);

    const tz = await getTenantTimezone(this.prisma, tenantId);
    const dateStr = query.date?.trim() || todayYmdInTimeZone(tz);
    const asOf = endOfDay(dateStr);

    const bills = await this.prisma.vendorBill.findMany({
      where: {
        tenantId,
        status: { in: [VendorBillStatus.UNPAID, VendorBillStatus.PARTIALLY_PAID] },
        OR: [{ dueDate: { lte: asOf } }, { dueDate: null }],
      },
      include: {
        vendor: { select: { id: true, name: true, phone: true } },
      },
      orderBy: [{ dueDate: 'asc' }, { billDate: 'asc' }],
    });

    type BillRow = {
      id: string;
      billNumber: string | null;
      billDate: Date;
      dueDate: Date | null;
      totalAmount: number;
      paidAmount: number;
      remaining: number;
      status: VendorBillStatus;
      overdue: boolean;
      noDueDate: boolean;
    };

    const byVendor = new Map<
      string,
      {
        vendorId: string;
        vendorName: string;
        phone: string | null;
        dueAmount: number;
        bills: BillRow[];
      }
    >();

    for (const b of bills) {
      const total = decimalToNumber(b.totalAmount);
      const paid = decimalToNumber(b.paidAmount);
      const remaining = Math.max(0, total - paid);
      if (remaining <= 0) continue;

      const noDueDate = !b.dueDate;
      const overdue = !!b.dueDate && b.dueDate < parseDate(dateStr);
      const row: BillRow = {
        id: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate,
        dueDate: b.dueDate,
        totalAmount: total,
        paidAmount: paid,
        remaining: round2(remaining),
        status: b.status,
        overdue,
        noDueDate,
      };

      const existing = byVendor.get(b.vendorId);
      if (existing) {
        existing.dueAmount = round2(existing.dueAmount + remaining);
        existing.bills.push(row);
      } else {
        byVendor.set(b.vendorId, {
          vendorId: b.vendorId,
          vendorName: b.vendor.name,
          phone: b.vendor.phone,
          dueAmount: round2(remaining),
          bills: [row],
        });
      }
    }

    const vendors = [...byVendor.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));
    const totalDue = round2(vendors.reduce((s, v) => s + v.dueAmount, 0));

    return {
      date: dateStr,
      totalDue,
      vendorCount: vendors.length,
      vendors,
    };
  }

  private async nextBillNumber(tx: Prisma.TransactionClient, tenantId: string) {
    const count = await tx.vendorBill.count({ where: { tenantId } });
    return `VB-${String(count + 1).padStart(5, '0')}`;
  }

  private async requireBill(tenantId: string, id: string, withDetails: boolean) {
    const bill = await this.prisma.vendorBill.findFirst({
      where: { id, tenantId },
      include: {
        vendor: { select: { id: true, name: true, phone: true } },
        lines: withDetails ? { orderBy: { lineNo: 'asc' } } : false,
        payments: withDetails ? { orderBy: { createdAt: 'desc' } } : false,
      },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found');
    return bill;
  }

  private mapBill(r: {
    id: string;
    tenantId: string;
    vendorId: string;
    purchaseOrderId: string | null;
    goodsReceiptId: string | null;
    billNumber: string | null;
    billDate: Date;
    dueDate: Date | null;
    notes: string | null;
    status: VendorBillStatus;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
    voidReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    vendor?: { id: string; name: string; phone: string | null };
  }) {
    const total = decimalToNumber(r.totalAmount);
    const paid = decimalToNumber(r.paidAmount);
    return {
      id: r.id,
      tenantId: r.tenantId,
      vendorId: r.vendorId,
      purchaseOrderId: r.purchaseOrderId,
      goodsReceiptId: r.goodsReceiptId,
      billNumber: r.billNumber,
      billDate: r.billDate,
      dueDate: r.dueDate,
      notes: r.notes,
      status: r.status,
      totalAmount: total,
      paidAmount: paid,
      remaining: Math.max(0, total - paid),
      voidReason: r.voidReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      vendor: r.vendor,
    };
  }

  private mapDetail(bill: {
    id: string;
    tenantId: string;
    vendorId: string;
    purchaseOrderId: string | null;
    goodsReceiptId: string | null;
    billNumber: string | null;
    billDate: Date;
    dueDate: Date | null;
    notes: string | null;
    status: VendorBillStatus;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
    voidReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    vendor: { id: string; name: string; phone: string | null };
    lines: Array<{
      id: string;
      lineNo: number;
      description: string;
      qty: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      amount: Prisma.Decimal;
    }>;
    payments: Array<{
      id: string;
      amount: Prisma.Decimal;
      paymentDate: Date;
      method: string;
      reference: string | null;
      notes: string | null;
      createdAt: Date;
    }>;
  }) {
    return {
      ...this.mapBill(bill),
      lines: bill.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        qty: decimalToNumber(l.qty),
        unitCost: decimalToNumber(l.unitCost),
        amount: decimalToNumber(l.amount),
      })),
      payments: bill.payments.map((p) => ({
        id: p.id,
        amount: decimalToNumber(p.amount),
        paymentDate: p.paymentDate,
        method: p.method,
        reference: p.reference,
        notes: p.notes,
        createdAt: p.createdAt,
      })),
    };
  }
}
