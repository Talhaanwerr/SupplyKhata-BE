import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CustomerStatus, PaymentCycle } from '../common/enums/customer.enum';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { CreateCustomerDto, CustomerProductPriceInputDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ListCustomerLedgerQueryDto } from './dto/list-customer-ledger-query.dto';
import { CustomerStatementQueryDto } from './dto/customer-statement-query.dto';
import { LedgerEntryType, ContainerMovementType } from '../common/enums/delivery.enum';
import { customerContainerSignedQty } from '../common/helpers/container-balance.helper';
import { clearPromisedDueIfSettled } from '../common/helpers/promised-due.helper';
import {
  assertReturnableContainersEnabled,
  isReturnableContainersEnabled,
} from '../common/helpers/returnable-containers.helper';
import { AdjustCustomerContainersDto } from './dto/adjust-customer-containers.dto';
import { OpeningContainerInputDto } from './dto/create-customer.dto';

type DecimalLike = Prisma.Decimal | number | null | undefined;

function decimalToNumber(value: DecimalLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function parseLedgerDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return parsed;
}

function endOfLedgerDay(value: string): Date {
  const d = parseLedgerDate(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

const customerInclude = {
  area: { select: { id: true, name: true, isActive: true } },
  defaultRider: { select: { id: true, firstName: true, lastName: true, email: true } },
  productPrices: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          defaultSellingPrice: true,
          isActive: true,
          unit: true,
          volume: true,
        },
      },
    },
  },
} as const;

type CustomerAreaRef = { id: string; name: string; isActive: boolean };

type CustomerListRow = {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  phone: string;
  secondaryPhone: string | null;
  address: string;
  areaId: string;
  status: CustomerStatus;
  paymentCycle: PaymentCycle;
  createdAt: Date;
  updatedAt: Date;
  area: CustomerAreaRef;
};

type CustomerProductPriceRow = {
  id: string;
  productId: string;
  pricePerUnit: DecimalLike;
  product: {
    id: string;
    name: string;
    defaultSellingPrice: DecimalLike;
    isActive: boolean;
    unit: string | null;
    volume: DecimalLike;
  };
};

type CustomerDetailRow = CustomerListRow & {
  locationNotes: string | null;
  billingDueDate: number | null;
  billingAnchorDate: Date | null;
  promisedDueDate: Date | null;
  promisedDueAmount: DecimalLike;
  openingReceivableBalance: DecimalLike;
  containerDeposit: DecimalLike;
  defaultRiderId: string | null;
  defaultRider: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  productPrices: CustomerProductPriceRow[];
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(
    tenantId: string,
    query: ListCustomersQueryDto,
  ): Promise<PaginatedData<ReturnType<CustomersService['toListItem']>>> {
    const { skip, take } = getPaginationParams(query);
    const where: {
      tenantId: string;
      deletedAt: null;
      status?: CustomerStatus;
      areaId?: string;
      OR?: Array<Record<string, { contains: string }>>;
    } = {
      tenantId,
      deletedAt: null,
    };

    if (query.status) where.status = query.status;
    if (query.areaId) where.areaId = query.areaId;

    const searchTerm = (query.search ?? query.q)?.trim();
    if (searchTerm) {
      where.OR = [
        { name: { contains: searchTerm } },
        { phone: { contains: searchTerm } },
        { secondaryPhone: { contains: searchTerm } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: {
          area: { select: { id: true, name: true, isActive: true } },
        },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      items: (rows as CustomerListRow[]).map((r) => this.toListItem(r)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await clearPromisedDueIfSettled(this.prisma, tenantId, id);
    const customer = await this.findActiveOrThrow(id, tenantId);
    return this.toDetail(customer);
  }

  async create(tenantId: string, dto: CreateCustomerDto, actorId: string) {
    this.assertAreaInput(dto.areaId, dto.areaName);
    const paymentCycle = dto.paymentCycle ?? PaymentCycle.CASH_ON_DELIVERY;
    const billing = this.resolveBillingFields(
      paymentCycle,
      dto.billingDueDate,
      dto.billingAnchorDate,
    );

    const customer = await this.prisma.$transaction(async (tx) => {
      const areaId = await this.resolveAreaId(tx, tenantId, dto.areaId, dto.areaName, false);
      await this.assertRider(tx, tenantId, dto.defaultRiderId);

      if (dto.customerProductPrices?.length) {
        await this.assertProductsBelongToTenant(tx, tenantId, dto.customerProductPrices);
      }
      if (dto.openingContainers?.length) {
        await assertReturnableContainersEnabled(tx, tenantId);
        await this.assertOpeningContainers(tx, tenantId, dto.openingContainers);
      }

      const created = await tx.customer.create({
        data: {
          tenantId,
          name: dto.name.trim(),
          email: dto.email ?? null,
          phone: dto.phone.trim(),
          secondaryPhone: dto.secondaryPhone ?? null,
          address: dto.address.trim(),
          areaId,
          locationNotes: dto.locationNotes ?? null,
          status: dto.status ?? CustomerStatus.ACTIVE,
          paymentCycle,
          billingDueDate: billing.billingDueDate,
          billingAnchorDate: billing.billingAnchorDate,
          openingReceivableBalance: dto.openingReceivableBalance ?? 0,
          containerDeposit: dto.containerDeposit ?? 0,
          defaultRiderId: dto.defaultRiderId || null,
          productPrices: dto.customerProductPrices?.length
            ? {
                create: dto.customerProductPrices.map((price) => ({
                  tenantId,
                  productId: price.productId,
                  pricePerUnit: price.pricePerUnit,
                })),
              }
            : undefined,
        },
        include: customerInclude,
      });

      const opening = Number(dto.openingReceivableBalance ?? 0);
      if (opening !== 0) {
        await tx.customerLedgerEntry.create({
          data: {
            tenantId,
            customerId: created.id,
            entryType: LedgerEntryType.OPENING_BALANCE,
            amount: opening,
            referenceType: 'customer',
            referenceId: created.id,
            notes: 'Opening receivable balance',
          },
        });
      }

      if (dto.openingContainers?.length) {
        for (const row of dto.openingContainers) {
          if (row.quantity <= 0) continue;
          await tx.containerMovement.create({
            data: {
              tenantId,
              productId: row.productId,
              customerId: created.id,
              quantity: row.quantity,
              movementType: ContainerMovementType.OPENING_WITH_CUSTOMER,
              notes: 'Opening balance on customer create',
            },
          });
        }
      }

      return created as unknown as CustomerDetailRow;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'customers',
      action: 'CREATE',
      entityId: customer.id,
      newValue: { name: customer.name, areaId: customer.areaId, email: customer.email },
    });

    return this.toDetail(customer);
  }

  async update(id: string, tenantId: string, dto: UpdateCustomerDto, actorId: string) {
    const existing = await this.findActiveOrThrow(id, tenantId);

    if (dto.areaId !== undefined || dto.areaName !== undefined) {
      this.assertAreaInput(dto.areaId, dto.areaName, true);
    }

    const nextCycle = (dto.paymentCycle ?? existing.paymentCycle) as PaymentCycle;
    const cycleOrBillingTouched =
      dto.paymentCycle !== undefined ||
      dto.billingDueDate !== undefined ||
      dto.billingAnchorDate !== undefined;

    let billingPatch: {
      billingDueDate?: number | null;
      billingAnchorDate?: Date | null;
    } = {};

    if (cycleOrBillingTouched) {
      const due = dto.billingDueDate !== undefined ? dto.billingDueDate : existing.billingDueDate;
      const anchorIso =
        dto.billingAnchorDate !== undefined
          ? dto.billingAnchorDate
          : existing.billingAnchorDate
            ? existing.billingAnchorDate.toISOString().slice(0, 10)
            : null;
      const billing = this.resolveBillingFields(nextCycle, due, anchorIso);
      billingPatch = {
        billingDueDate: billing.billingDueDate,
        billingAnchorDate: billing.billingAnchorDate,
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      let areaId: string | undefined;
      if (dto.areaId !== undefined || dto.areaName !== undefined) {
        areaId = await this.resolveAreaId(tx, tenantId, dto.areaId, dto.areaName, true);
      }

      if (dto.defaultRiderId !== undefined) {
        await this.assertRider(tx, tenantId, dto.defaultRiderId);
      }

      if (dto.customerProductPrices) {
        await this.assertProductsBelongToTenant(tx, tenantId, dto.customerProductPrices);
        await tx.customerProductPrice.deleteMany({ where: { tenantId, customerId: id } });
        if (dto.customerProductPrices.length > 0) {
          await tx.customerProductPrice.createMany({
            data: dto.customerProductPrices.map((price) => ({
              tenantId,
              customerId: id,
              productId: price.productId,
              pricePerUnit: price.pricePerUnit,
            })),
          });
        }
      }

      const row = await tx.customer.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone.trim() } : {}),
          ...(dto.secondaryPhone !== undefined ? { secondaryPhone: dto.secondaryPhone } : {}),
          ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
          ...(areaId !== undefined ? { areaId } : {}),
          ...(dto.locationNotes !== undefined ? { locationNotes: dto.locationNotes } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.paymentCycle !== undefined ? { paymentCycle: dto.paymentCycle } : {}),
          ...(cycleOrBillingTouched
            ? {
                billingDueDate: billingPatch.billingDueDate,
                billingAnchorDate: billingPatch.billingAnchorDate,
              }
            : {}),
          ...(dto.openingReceivableBalance !== undefined
            ? { openingReceivableBalance: dto.openingReceivableBalance }
            : {}),
          ...(dto.containerDeposit !== undefined ? { containerDeposit: dto.containerDeposit } : {}),
          ...(dto.defaultRiderId !== undefined
            ? { defaultRiderId: dto.defaultRiderId || null }
            : {}),
        },
        include: customerInclude,
      });

      if (dto.openingReceivableBalance !== undefined) {
        const opening = Number(dto.openingReceivableBalance);
        const existingOpening = await tx.customerLedgerEntry.findFirst({
          where: {
            tenantId,
            customerId: id,
            entryType: LedgerEntryType.OPENING_BALANCE,
          },
          orderBy: { createdAt: 'asc' },
        });
        if (existingOpening) {
          if (opening === 0) {
            await tx.customerLedgerEntry.delete({ where: { id: existingOpening.id } });
          } else {
            await tx.customerLedgerEntry.update({
              where: { id: existingOpening.id },
              data: { amount: opening, notes: 'Opening receivable balance' },
            });
          }
        } else if (opening !== 0) {
          await tx.customerLedgerEntry.create({
            data: {
              tenantId,
              customerId: id,
              entryType: LedgerEntryType.OPENING_BALANCE,
              amount: opening,
              referenceType: 'customer',
              referenceId: id,
              notes: 'Opening receivable balance',
            },
          });
        }
      }

      return row as unknown as CustomerDetailRow;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'customers',
      action: 'UPDATE',
      entityId: id,
      oldValue: { name: existing.name, status: existing.status, areaId: existing.areaId },
      newValue: dto as unknown as Record<string, unknown>,
    });

    return this.toDetail(updated);
  }

  async containerBalance(id: string, tenantId: string) {
    await this.findActiveOrThrow(id, tenantId);

    if (!(await isReturnableContainersEnabled(this.prisma, tenantId))) {
      return [];
    }

    const products = await this.prisma.product.findMany({
      where: { tenantId, deletedAt: null, isReturnable: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const movements = await this.prisma.containerMovement.findMany({
      where: {
        tenantId,
        customerId: id,
        productId: { in: products.map((p) => p.id) },
      },
      select: { productId: true, movementType: true, quantity: true },
    });

    const balanceByProduct = new Map<string, { balance: number; movementsCount: number }>();
    for (const m of movements) {
      const prev = balanceByProduct.get(m.productId) ?? { balance: 0, movementsCount: 0 };
      prev.balance += customerContainerSignedQty(m.movementType, m.quantity);
      prev.movementsCount += 1;
      balanceByProduct.set(m.productId, prev);
    }

    return products.map((product) => {
      const row = balanceByProduct.get(product.id);
      return {
        productId: product.id,
        productName: product.name,
        balance: row?.balance ?? 0,
        movementsCount: row?.movementsCount ?? 0,
      };
    });
  }

  async adjustContainers(
    id: string,
    tenantId: string,
    dto: AdjustCustomerContainersDto,
    actorId: string,
  ) {
    if (dto.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta must be non-zero');
    }

    await assertReturnableContainersEnabled(this.prisma, tenantId);
    await this.findActiveOrThrow(id, tenantId);
    await this.assertReturnableProduct(this.prisma, tenantId, dto.productId);

    const movement = await this.prisma.containerMovement.create({
      data: {
        tenantId,
        productId: dto.productId,
        customerId: id,
        quantity: dto.quantityDelta,
        movementType: ContainerMovementType.ADJUSTMENT,
        notes: dto.notes?.trim() || 'Customer container adjustment',
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'customers',
      action: 'UPDATE',
      entityId: id,
      newValue: {
        containerAdjustment: {
          productId: dto.productId,
          quantityDelta: dto.quantityDelta,
          movementId: movement.id,
        },
      },
    });

    return this.containerBalance(id, tenantId);
  }

  async softDelete(id: string, tenantId: string, actorId: string): Promise<void> {
    const existing = await this.findActiveOrThrow(id, tenantId);
    await this.prisma.customer.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: CustomerStatus.INACTIVE,
        name: `${existing.name}_deleted_${Date.now()}`,
      },
    });
    await this.audit.write({
      tenantId,
      actorId,
      module: 'customers',
      action: 'DELETE',
      entityId: id,
      oldValue: { name: existing.name },
      newValue: { deletedAt: new Date().toISOString() },
    });
  }

  async ledger(id: string, tenantId: string, query: ListCustomerLedgerQueryDto) {
    await this.findActiveOrThrow(id, tenantId);

    const from = query.from ? parseLedgerDate(query.from) : null;
    const to = query.to ? endOfLedgerDay(query.to) : null;

    let openingBalance = 0;
    if (from) {
      const before = await this.prisma.customerLedgerEntry.aggregate({
        where: { tenantId, customerId: id, createdAt: { lt: from } },
        _sum: { amount: true },
      });
      openingBalance = decimalToNumber(before._sum.amount);
    }

    const where: Prisma.CustomerLedgerEntryWhereInput = { tenantId, customerId: id };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    // Running balance must be chronological from opening (or zero at start of history).
    const allInScope = await this.prisma.customerLedgerEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        entryType: true,
        amount: true,
        referenceId: true,
        referenceType: true,
        notes: true,
        createdAt: true,
      },
    });

    let running = openingBalance;
    const withBalance = allInScope.map((entry) => {
      const amount = decimalToNumber(entry.amount);
      running += amount;
      const debit = amount > 0 ? amount : 0;
      const credit = amount < 0 ? -amount : 0;
      return {
        id: entry.id,
        entryType: entry.entryType as LedgerEntryType,
        amount,
        debit: Math.round(debit * 100) / 100,
        credit: Math.round(credit * 100) / 100,
        runningBalance: Math.round(running * 100) / 100,
        description: entry.notes || entry.entryType,
        referenceId: entry.referenceId,
        referenceType: entry.referenceType,
        createdAt: entry.createdAt,
      };
    });

    const { skip, take } = getPaginationParams(query);
    // Return newest-first page while preserving correct running balances computed above.
    const newestFirst = [...withBalance].reverse();
    const pageItems = newestFirst.slice(skip, skip + take);

    return {
      customerId: id,
      items: pageItems,
      meta: buildPaginationMeta(withBalance.length, query.page, query.limit),
    };
  }

  async balance(id: string, tenantId: string) {
    await this.findActiveOrThrow(id, tenantId);
    const agg = await this.prisma.customerLedgerEntry.aggregate({
      where: { tenantId, customerId: id },
      _sum: { amount: true },
    });
    return {
      customerId: id,
      balance: Math.round(decimalToNumber(agg._sum.amount) * 100) / 100,
    };
  }

  async statement(id: string, tenantId: string, query: CustomerStatementQueryDto) {
    const customer = await this.findActiveOrThrow(id, tenantId);

    const from = query.from ? parseLedgerDate(query.from) : null;
    const to = query.to ? endOfLedgerDay(query.to) : null;

    let openingBalance = 0;
    if (from) {
      const before = await this.prisma.customerLedgerEntry.aggregate({
        where: { tenantId, customerId: id, createdAt: { lt: from } },
        _sum: { amount: true },
      });
      openingBalance = decimalToNumber(before._sum.amount);
    }

    const where: Prisma.CustomerLedgerEntryWhereInput = { tenantId, customerId: id };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const entries = await this.prisma.customerLedgerEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        entryType: true,
        amount: true,
        referenceId: true,
        referenceType: true,
        notes: true,
        createdAt: true,
      },
    });

    let running = openingBalance;
    const items = entries.map((entry) => {
      const amount = decimalToNumber(entry.amount);
      running += amount;
      const debit = amount > 0 ? amount : 0;
      const credit = amount < 0 ? -amount : 0;
      return {
        id: entry.id,
        entryType: entry.entryType as LedgerEntryType,
        amount,
        debit: Math.round(debit * 100) / 100,
        credit: Math.round(credit * 100) / 100,
        runningBalance: Math.round(running * 100) / 100,
        description: entry.notes || entry.entryType,
        referenceId: entry.referenceId,
        referenceType: entry.referenceType,
        createdAt: entry.createdAt,
      };
    });

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
      },
      from: query.from ?? null,
      to: query.to ?? null,
      openingBalance: Math.round(openingBalance * 100) / 100,
      closingBalance: Math.round(running * 100) / 100,
      items,
    };
  }

  async resolvePrice(id: string, tenantId: string, productId: string) {
    await this.findActiveOrThrow(id, tenantId);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
      select: { id: true, name: true, defaultSellingPrice: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const override = await this.prisma.customerProductPrice.findUnique({
      where: { customerId_productId: { customerId: id, productId } },
      select: { pricePerUnit: true },
    });

    const pricePerUnit = override
      ? decimalToNumber(override.pricePerUnit)
      : decimalToNumber(product.defaultSellingPrice);

    return {
      customerId: id,
      productId,
      productName: product.name,
      pricePerUnit,
      source: override ? ('CUSTOMER' as const) : ('PRODUCT_DEFAULT' as const),
    };
  }

  private resolveBillingFields(
    cycle: PaymentCycle,
    billingDueDate?: number | null,
    billingAnchorDate?: string | null,
  ): { billingDueDate: number | null; billingAnchorDate: Date | null } {
    if (cycle === PaymentCycle.CASH_ON_DELIVERY) {
      return { billingDueDate: null, billingAnchorDate: null };
    }

    if (cycle === PaymentCycle.WEEKLY || cycle === PaymentCycle.FORTNIGHTLY) {
      if (!billingAnchorDate?.trim()) {
        throw new BadRequestException(
          'billingAnchorDate is required for WEEKLY and FORTNIGHTLY cycles',
        );
      }
      const parsed = new Date(billingAnchorDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid billingAnchorDate');
      }
      parsed.setHours(0, 0, 0, 0);
      return { billingDueDate: null, billingAnchorDate: parsed };
    }

    // MONTHLY / CUSTOM
    if (billingDueDate == null) {
      throw new BadRequestException(
        'billingDueDate (1–31) is required for MONTHLY and CUSTOM cycles',
      );
    }
    if (!Number.isInteger(billingDueDate) || billingDueDate < 1 || billingDueDate > 31) {
      throw new BadRequestException('billingDueDate must be an integer between 1 and 31');
    }
    return { billingDueDate, billingAnchorDate: null };
  }

  private assertAreaInput(areaId?: string, areaName?: string, optionalBoth = false): void {
    const hasId = !!areaId?.trim();
    const hasName = !!areaName?.trim();
    if (optionalBoth && !hasId && !hasName) return;
    if (hasId === hasName) {
      throw new BadRequestException('Provide exactly one of areaId or areaName');
    }
  }

  private async resolveAreaId(
    tx: Prisma.TransactionClient,
    tenantId: string,
    areaId: string | undefined,
    areaName: string | undefined,
    allowInactiveLinked: boolean,
  ): Promise<string> {
    if (areaId?.trim()) {
      const area = await tx.area.findFirst({
        where: { id: areaId.trim(), tenantId, deletedAt: null },
      });
      if (!area) throw new BadRequestException('Area not found in this workspace');
      if (!area.isActive && !allowInactiveLinked) {
        throw new BadRequestException('Selected area is inactive');
      }
      return area.id;
    }

    const name = areaName!.trim();
    const existing = await tx.area.findFirst({
      where: { tenantId, name, deletedAt: null },
    });

    if (existing) {
      if (!existing.isActive) {
        await tx.area.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
      }
      return existing.id;
    }

    const created = await tx.area.create({
      data: { tenantId, name, isActive: true },
      select: { id: true },
    });
    return created.id;
  }

  private async assertRider(
    tx: Prisma.TransactionClient,
    tenantId: string,
    riderId: string | null | undefined,
  ): Promise<void> {
    if (!riderId) return;
    const member = await tx.tenantMember.findUnique({
      where: { userId_tenantId: { userId: riderId, tenantId } },
      select: { status: true },
    });
    if (!member || member.status === 'INACTIVE') {
      throw new BadRequestException('Default rider must be an active workspace member');
    }
  }

  private async assertProductsBelongToTenant(
    tx: Prisma.TransactionClient,
    tenantId: string,
    prices: CustomerProductPriceInputDto[],
  ): Promise<void> {
    const ids = [...new Set(prices.map((price) => price.productId))];
    const count = await tx.product.count({
      where: { tenantId, deletedAt: null, id: { in: ids } },
    });
    if (count !== ids.length) {
      throw new BadRequestException('One or more products are invalid for this workspace');
    }
  }

  private async assertOpeningContainers(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rows: OpeningContainerInputDto[],
  ): Promise<void> {
    const ids = rows.map((row) => row.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once in openingContainers');
    }
    const products = await tx.product.findMany({
      where: {
        tenantId,
        deletedAt: null,
        isActive: true,
        isReturnable: true,
        id: { in: ids },
      },
      select: { id: true },
    });
    if (products.length !== ids.length) {
      throw new BadRequestException(
        'openingContainers must use active returnable products in this workspace',
      );
    }
  }

  private async assertReturnableProduct(
    db: PrismaService | Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const product = await db.product.findFirst({
      where: {
        id: productId,
        tenantId,
        deletedAt: null,
        isActive: true,
        isReturnable: true,
      },
      select: { id: true },
    });
    if (!product) {
      throw new BadRequestException(
        'Product must be an active returnable product in this workspace',
      );
    }
  }

  private async findActiveOrThrow(id: string, tenantId: string): Promise<CustomerDetailRow> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: customerInclude,
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer as unknown as CustomerDetailRow;
  }

  private toListItem(row: CustomerListRow) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      secondaryPhone: row.secondaryPhone,
      address: row.address,
      areaId: row.areaId,
      area: row.area,
      status: row.status,
      paymentCycle: row.paymentCycle,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toDetail(row: CustomerDetailRow) {
    return {
      ...this.toListItem(row),
      locationNotes: row.locationNotes,
      billingDueDate: row.billingDueDate,
      billingAnchorDate: row.billingAnchorDate
        ? row.billingAnchorDate.toISOString().slice(0, 10)
        : null,
      promisedDueDate: row.promisedDueDate ? row.promisedDueDate.toISOString().slice(0, 10) : null,
      promisedDueAmount:
        row.promisedDueAmount == null ? null : decimalToNumber(row.promisedDueAmount),
      openingReceivableBalance: decimalToNumber(row.openingReceivableBalance),
      containerDeposit: decimalToNumber(row.containerDeposit),
      defaultRiderId: row.defaultRiderId,
      defaultRider: row.defaultRider,
      productPrices: row.productPrices.map((price: CustomerProductPriceRow) => ({
        id: price.id,
        productId: price.productId,
        pricePerUnit: decimalToNumber(price.pricePerUnit),
        product: {
          id: price.product.id,
          name: price.product.name,
          defaultSellingPrice: decimalToNumber(price.product.defaultSellingPrice),
          isActive: price.product.isActive,
          unit: price.product.unit,
          volume: price.product.volume != null ? decimalToNumber(price.product.volume) : null,
        },
      })),
    };
  }
}
