import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ContainerMovementType as PrismaContainerMovementType,
  DeliveryStatus as PrismaDeliveryStatus,
  LedgerEntryType as PrismaLedgerEntryType,
  PaymentMethod as PrismaPaymentMethod,
  Prisma,
  RunStatus as PrismaRunStatus,
  StockType as PrismaStockType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { DeliveryStatus } from '../common/enums/delivery.enum';
import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';

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

function startOfDayLocal(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreateDeliveryDto, actorId: string) {
    this.assertItems(dto.items);
    const deliveryDate = parseDate(dto.deliveryDate);

    let promisedPayDate: Date | null = null;
    if (dto.promisedPayDate) {
      promisedPayDate = parseDate(dto.promisedPayDate);
      if (startOfDayLocal(promisedPayDate).getTime() < startOfDayLocal(deliveryDate).getTime()) {
        throw new BadRequestException('Promised pay date cannot be before delivery date');
      }
    }
    if (dto.promisedAmount != null && dto.promisedAmount > 0 && !promisedPayDate) {
      throw new BadRequestException('Promised amount requires a promised pay date');
    }
    const promisedAmount =
      promisedPayDate && dto.promisedAmount != null && dto.promisedAmount > 0
        ? dto.promisedAmount
        : null;

    const delivery = await this.prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findFirst({
        where: { id: dto.deliveryRunId, tenantId },
        select: { id: true, status: true, vehicleId: true },
      });
      if (!run) throw new BadRequestException('Delivery run not found in this workspace');
      if (run.status !== PrismaRunStatus.OPEN) {
        throw new BadRequestException('Cannot add delivery to a closed run');
      }

      const customer = await tx.customer.findFirst({
        where: { id: dto.customerId, tenantId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!customer) throw new BadRequestException('Customer not found in this workspace');

      const productIds = dto.items.map((item) => item.productId);
      const products = await tx.product.findMany({
        where: { tenantId, deletedAt: null, isActive: true, id: { in: productIds } },
        select: { id: true, name: true, defaultSellingPrice: true },
      });
      if (products.length !== productIds.length) {
        throw new BadRequestException('One or more products are invalid for this workspace');
      }

      const prices = await tx.customerProductPrice.findMany({
        where: { tenantId, customerId: dto.customerId, productId: { in: productIds } },
        select: { productId: true, pricePerUnit: true },
      });
      const priceMap = new Map(prices.map((price) => [price.productId, price.pricePerUnit]));
      const productMap = new Map(products.map((product) => [product.id, product]));

      const resolvedItems = [];
      for (const item of dto.items) {
        if (item.quantityDelivered === 0 && (item.emptiesReceived ?? 0) === 0) {
          continue;
        }
        const product = productMap.get(item.productId);
        if (!product) throw new BadRequestException('Product not found');

        const cost = await tx.productCostHistory.findFirst({
          where: { tenantId, productId: item.productId, effectiveFrom: { lte: deliveryDate } },
          orderBy: { effectiveFrom: 'desc' },
          select: { costPerUnit: true },
        });
        if (!cost) {
          throw new BadRequestException(
            `Missing product cost history for "${product.name}" on delivery date`,
          );
        }

        const sellingPrice = priceMap.get(item.productId) ?? product.defaultSellingPrice;
        const lineTotal = new Prisma.Decimal(sellingPrice).mul(item.quantityDelivered);
        resolvedItems.push({
          productId: item.productId,
          quantityDelivered: item.quantityDelivered,
          emptiesReceived: item.emptiesReceived ?? 0,
          sellingPriceSnapshot: sellingPrice,
          unitCostSnapshot: cost.costPerUnit,
          lineTotal,
        });
      }

      if (resolvedItems.length === 0) {
        throw new BadRequestException('At least one delivered or returned container is required');
      }

      await this.assertFilledStockAvailable(
        tx,
        tenantId,
        dto.deliveryRunId,
        resolvedItems,
        productMap,
      );

      const totalSales = resolvedItems.reduce(
        (sum, item) => sum.plus(item.lineTotal),
        new Prisma.Decimal(0),
      );
      const cashReceived = dto.cashReceived ?? 0;

      const created = await tx.delivery.create({
        data: {
          tenantId,
          deliveryRunId: dto.deliveryRunId,
          customerId: dto.customerId,
          deliveryDate,
          paymentMethod: (dto.paymentMethod ?? PrismaPaymentMethod.CASH) as PrismaPaymentMethod,
          cashReceived,
          status: PrismaDeliveryStatus.DELIVERED,
          notes: dto.notes?.trim() || null,
          promisedPayDate,
          promisedAmount,
        },
      });

      for (const item of resolvedItems) {
        const createdItem = await tx.deliveryItem.create({
          data: {
            tenantId,
            deliveryId: created.id,
            productId: item.productId,
            quantityDelivered: item.quantityDelivered,
            emptiesReceived: item.emptiesReceived,
            sellingPriceSnapshot: item.sellingPriceSnapshot,
            unitCostSnapshot: item.unitCostSnapshot,
            lineTotal: item.lineTotal,
          },
        });

        if (item.quantityDelivered > 0) {
          await tx.containerMovement.create({
            data: {
              tenantId,
              productId: item.productId,
              deliveryItemId: createdItem.id,
              customerId: dto.customerId,
              vehicleId: run.vehicleId,
              movementType: PrismaContainerMovementType.DELIVERED_TO_CUSTOMER,
              quantity: item.quantityDelivered,
              notes: 'Delivery sale',
            },
          });
        }

        if (item.emptiesReceived > 0) {
          await tx.containerMovement.create({
            data: {
              tenantId,
              productId: item.productId,
              deliveryItemId: createdItem.id,
              customerId: dto.customerId,
              vehicleId: run.vehicleId,
              movementType: PrismaContainerMovementType.RETURNED_FROM_CUSTOMER,
              quantity: item.emptiesReceived,
              notes: 'Empty containers returned',
            },
          });
        }
      }

      await tx.customerLedgerEntry.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          entryType: PrismaLedgerEntryType.DELIVERY_SALE,
          amount: totalSales,
          referenceId: created.id,
          referenceType: 'delivery',
          notes: 'Delivery sale',
        },
      });

      if (cashReceived > 0) {
        await tx.customerLedgerEntry.create({
          data: {
            tenantId,
            customerId: dto.customerId,
            entryType: PrismaLedgerEntryType.PAYMENT,
            amount: new Prisma.Decimal(cashReceived).neg(),
            referenceId: created.id,
            referenceType: 'delivery',
            notes: 'Delivery cash received',
          },
        });
      }

      await tx.deliveryRun.update({
        where: { id: dto.deliveryRunId },
        data: {
          totalSales: { increment: totalSales },
          totalCashCollected: { increment: cashReceived },
        },
      });

      if (promisedPayDate) {
        await tx.customer.update({
          where: { id: dto.customerId },
          data: {
            promisedDueDate: promisedPayDate,
            promisedDueAmount: promisedAmount,
            promisedDueDeliveryId: created.id,
          },
        });
      }

      return tx.delivery.findFirstOrThrow({
        where: { id: created.id, tenantId },
        include: this.detailInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveries',
      action: 'CREATE',
      entityId: delivery.id,
      newValue: { deliveryRunId: delivery.deliveryRunId, customerId: delivery.customerId },
    });

    return this.toDetail(delivery);
  }

  async list(
    tenantId: string,
    query: ListDeliveriesQueryDto,
  ): Promise<PaginatedData<ReturnType<DeliveriesService['toListItem']>>> {
    const { skip, take } = getPaginationParams(query);
    const where: Prisma.DeliveryWhereInput = { tenantId };

    if (query.runId) where.deliveryRunId = query.runId;
    if (query.customerId) where.customerId = query.customerId;
    if (query.status) where.status = query.status as unknown as PrismaDeliveryStatus;
    if (query.dateFrom || query.dateTo) {
      where.deliveryDate = {};
      if (query.dateFrom) where.deliveryDate.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.deliveryDate.lte = endOfDay(query.dateTo);
    }

    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        skip,
        take,
        orderBy: { deliveryDate: 'desc' },
        include: this.detailInclude(),
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id, tenantId },
      include: this.detailInclude(),
    });
    if (!delivery) throw new NotFoundException('Delivery not found');
    return this.toDetail(delivery);
  }

  async cancel(id: string, tenantId: string, actorId: string) {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findFirst({
        where: { id, tenantId },
        include: {
          items: true,
          deliveryRun: { select: { id: true, status: true } },
        },
      });
      if (!delivery) throw new NotFoundException('Delivery not found');
      if (delivery.status === PrismaDeliveryStatus.CANCELLED) {
        throw new BadRequestException('Delivery is already cancelled');
      }
      if (delivery.deliveryRun.status !== PrismaRunStatus.OPEN) {
        throw new BadRequestException('Cannot cancel a delivery on a closed run');
      }

      const itemIds = delivery.items.map((item) => item.id);
      const [ledgerEntries, movements] = await Promise.all([
        tx.customerLedgerEntry.findMany({
          where: {
            tenantId,
            referenceId: id,
            entryType: {
              in: [PrismaLedgerEntryType.DELIVERY_SALE, PrismaLedgerEntryType.PAYMENT],
            },
          },
        }),
        tx.containerMovement.findMany({
          where: {
            tenantId,
            deliveryItemId: { in: itemIds },
            movementType: {
              in: [
                PrismaContainerMovementType.DELIVERED_TO_CUSTOMER,
                PrismaContainerMovementType.RETURNED_FROM_CUSTOMER,
              ],
            },
          },
        }),
      ]);

      if (ledgerEntries.length > 0) {
        await tx.customerLedgerEntry.createMany({
          data: ledgerEntries.map((entry) => ({
            tenantId,
            customerId: entry.customerId,
            entryType: PrismaLedgerEntryType.ADJUSTMENT,
            amount: new Prisma.Decimal(entry.amount).neg(),
            referenceId: id,
            referenceType: 'delivery',
            notes: `Cancel reversal for ${entry.entryType}`,
          })),
        });
      }

      if (movements.length > 0) {
        await tx.containerMovement.createMany({
          data: movements.map((movement) => ({
            tenantId,
            productId: movement.productId,
            deliveryItemId: movement.deliveryItemId,
            customerId: movement.customerId,
            vehicleId: movement.vehicleId,
            // Keep productId required; use ADJUSTMENT with negated qty so empties
            // RETURNS are not flipped into false DELIVERED_TO_CUSTOMER rows.
            movementType: PrismaContainerMovementType.ADJUSTMENT,
            quantity: -movement.quantity,
            notes: 'Cancel reversal',
          })),
        });
      }

      const totalSales = delivery.items.reduce(
        (sum, item) => sum.plus(item.lineTotal),
        new Prisma.Decimal(0),
      );
      await tx.delivery.update({
        where: { id },
        data: { status: PrismaDeliveryStatus.CANCELLED },
      });
      await tx.deliveryRun.update({
        where: { id: delivery.deliveryRunId },
        data: {
          totalSales: { decrement: totalSales },
          totalCashCollected: { decrement: delivery.cashReceived },
        },
      });

      const customer = await tx.customer.findFirst({
        where: { id: delivery.customerId, tenantId },
        select: { promisedDueDeliveryId: true },
      });
      if (customer?.promisedDueDeliveryId === id) {
        await tx.customer.update({
          where: { id: delivery.customerId },
          data: {
            promisedDueDate: null,
            promisedDueAmount: null,
            promisedDueDeliveryId: null,
          },
        });
      }

      return tx.delivery.findFirstOrThrow({
        where: { id, tenantId },
        include: this.detailInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveries',
      action: 'CANCEL',
      entityId: id,
      oldValue: { status: DeliveryStatus.DELIVERED },
      newValue: { status: DeliveryStatus.CANCELLED },
    });

    return this.toDetail(cancelled);
  }

  private assertItems(items: CreateDeliveryDto['items']): void {
    const ids = items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once per delivery');
    }
    if (items.every((item) => item.quantityDelivered === 0 && (item.emptiesReceived ?? 0) === 0)) {
      throw new BadRequestException('At least one delivered or returned container is required');
    }
  }

  private async assertFilledStockAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryRunId: string,
    items: Array<{ productId: string; quantityDelivered: number }>,
    productMap: Map<string, { id: string; name: string }>,
  ): Promise<void> {
    const deliverItems = items.filter((item) => item.quantityDelivered > 0);
    if (deliverItems.length === 0) return;

    const productIds = deliverItems.map((item) => item.productId);
    const [openingStocks, priorDeliveries] = await Promise.all([
      tx.deliveryRunStock.findMany({
        where: {
          tenantId,
          deliveryRunId,
          stockType: PrismaStockType.OPENING,
          productId: { in: productIds },
        },
        select: { productId: true, filledCount: true },
      }),
      tx.delivery.findMany({
        where: {
          tenantId,
          deliveryRunId,
          status: { not: PrismaDeliveryStatus.CANCELLED },
        },
        select: {
          items: {
            where: { productId: { in: productIds } },
            select: { productId: true, quantityDelivered: true },
          },
        },
      }),
    ]);

    const openingFilled = new Map(openingStocks.map((row) => [row.productId, row.filledCount]));
    const alreadyDelivered = new Map<string, number>();
    for (const delivery of priorDeliveries) {
      for (const item of delivery.items) {
        alreadyDelivered.set(
          item.productId,
          (alreadyDelivered.get(item.productId) ?? 0) + item.quantityDelivered,
        );
      }
    }

    const requested = new Map<string, number>();
    for (const item of deliverItems) {
      requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.quantityDelivered);
    }

    for (const [productId, qty] of requested) {
      const opening = openingFilled.get(productId) ?? 0;
      const used = alreadyDelivered.get(productId) ?? 0;
      const available = opening - used;
      if (qty > available) {
        const name = productMap.get(productId)?.name ?? 'product';
        throw new BadRequestException(
          `Only ${available} filled left on this run for "${name}" (opening ${opening}, already delivered ${used})`,
        );
      }
    }
  }

  private detailInclude() {
    return {
      customer: { select: { id: true, name: true, phone: true } },
      deliveryRun: {
        select: {
          id: true,
          date: true,
          status: true,
          rider: { select: { id: true, firstName: true, lastName: true, email: true } },
          vehicle: { select: { id: true, name: true, plateNumber: true } },
        },
      },
      items: {
        include: { product: { select: { id: true, name: true } } },
      },
    };
  }

  private toListItem(
    row: Prisma.DeliveryGetPayload<{ include: ReturnType<DeliveriesService['detailInclude']> }>,
  ) {
    const totalSale = row.items.reduce((sum, item) => sum + decimalToNumber(item.lineTotal), 0);
    return {
      id: row.id,
      tenantId: row.tenantId,
      deliveryRunId: row.deliveryRunId,
      customerId: row.customerId,
      customer: row.customer,
      deliveryRun: row.deliveryRun,
      deliveryDate: row.deliveryDate,
      cashReceived: decimalToNumber(row.cashReceived),
      paymentMethod: row.paymentMethod,
      status: row.status as DeliveryStatus,
      notes: row.notes,
      promisedPayDate: row.promisedPayDate ? row.promisedPayDate.toISOString().slice(0, 10) : null,
      promisedAmount: row.promisedAmount == null ? null : decimalToNumber(row.promisedAmount),
      totalSale,
      productsSummary: row.items
        .filter((item) => item.quantityDelivered > 0 || item.emptiesReceived > 0)
        .map(
          (item) =>
            `${item.product.name} (${item.quantityDelivered} del / ${item.emptiesReceived} empty)`,
        )
        .join(', '),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toDetail(
    row: Prisma.DeliveryGetPayload<{ include: ReturnType<DeliveriesService['detailInclude']> }>,
  ) {
    return {
      ...this.toListItem(row),
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        product: item.product,
        quantityDelivered: item.quantityDelivered,
        emptiesReceived: item.emptiesReceived,
        sellingPriceSnapshot: decimalToNumber(item.sellingPriceSnapshot),
        unitCostSnapshot: decimalToNumber(item.unitCostSnapshot),
        lineTotal: decimalToNumber(item.lineTotal),
        createdAt: item.createdAt,
      })),
    };
  }
}
