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
import { clearPromisedDueIfSettled } from '../common/helpers/promised-due.helper';
import {
  assertNoEmptiesWhenContainersDisabled,
  isReturnableContainersEnabled,
  packagingUnitsOutForDelivery,
  RETURNABLE_CONTAINERS_DISABLED_MESSAGE,
} from '../common/helpers/returnable-containers.helper';
import { assertValidBaseQuantity, decimalQtyToNumber } from '../common/helpers/product-qty.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { DeliveryStatus } from '../common/enums/delivery.enum';
import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';
import { SchedulingService } from '../scheduling/scheduling.service';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';

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

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly scheduling: SchedulingService,
  ) {}

  async create(tenantId: string, dto: CreateDeliveryDto, actorId: string) {
    this.assertItems(dto.items);
    const deliveryDate = parseDate(dto.deliveryDate);
    const costAsOf = parseCalendarDateUtc(dto.deliveryDate, true);

    let promisedPayDate: Date | null = null;
    if (dto.promisedPayDate) {
      promisedPayDate = parseDate(dto.promisedPayDate);
      if (promisedPayDate.getTime() < deliveryDate.getTime()) {
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

    const productIds = dto.items.map((item) => item.productId);

    // Resolve lookups outside the interactive tx — only truck stock assert + writes stay inside.
    // DeliveryRunStock (OPENING/CLOSING) ≠ warehouse StockBalance. Do not call inventory SALE_OUT here.
    const [run, customer, products, prices, costRows, containersEnabled] = await Promise.all([
      this.prisma.deliveryRun.findFirst({
        where: { id: dto.deliveryRunId, tenantId },
        select: { id: true, status: true, vehicleId: true },
      }),
      this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      }),
      this.prisma.product.findMany({
        where: { tenantId, deletedAt: null, isActive: true, id: { in: productIds } },
        select: {
          id: true,
          name: true,
          defaultSellingPrice: true,
          isReturnable: true,
          baseUnit: true,
          allowFractionalQty: true,
          containerCapacity: true,
        },
      }),
      this.prisma.customerProductPrice.findMany({
        where: { tenantId, customerId: dto.customerId, productId: { in: productIds } },
        select: { productId: true, pricePerUnit: true },
      }),
      this.prisma.productCostHistory.findMany({
        where: {
          tenantId,
          productId: { in: productIds },
          effectiveFrom: { lte: costAsOf },
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        select: { productId: true, costPerUnit: true },
      }),
      isReturnableContainersEnabled(this.prisma, tenantId),
    ]);

    assertNoEmptiesWhenContainersDisabled(containersEnabled, dto.items);

    if (!run) throw new BadRequestException('Delivery run not found in this workspace');
    if (run.status !== PrismaRunStatus.OPEN) {
      throw new BadRequestException('Cannot add delivery to a closed run');
    }
    if (!customer) throw new BadRequestException('Customer not found in this workspace');
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid for this workspace');
    }

    const priceMap = new Map(prices.map((price) => [price.productId, price.pricePerUnit]));
    const productMap = new Map(products.map((product) => [product.id, product]));
    const costMap = new Map<string, Prisma.Decimal>();
    for (const row of costRows) {
      if (!costMap.has(row.productId)) costMap.set(row.productId, row.costPerUnit);
    }

    const resolvedItems: Array<{
      productId: string;
      quantityDelivered: number;
      emptiesReceived: number;
      containersDelivered: number;
      sellingPriceSnapshot: Prisma.Decimal;
      unitCostSnapshot: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
      trackContainers: boolean;
      /** Whole packaging units (cans) leaving with customer; 0 = no DELIVERED_TO_CUSTOMER. */
      packagingUnitsOut: number;
    }> = [];

    for (const item of dto.items) {
      if (item.quantityDelivered === 0 && (item.emptiesReceived ?? 0) === 0) {
        continue;
      }
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException('Product not found');

      assertValidBaseQuantity(item.quantityDelivered, product);

      const trackContainers = containersEnabled && product.isReturnable;
      const rawEmpties = item.emptiesReceived ?? 0;
      if (!trackContainers && rawEmpties > 0) {
        throw new BadRequestException(
          containersEnabled
            ? `Empties are not tracked for non-returnable product "${product.name}"`
            : RETURNABLE_CONTAINERS_DISABLED_MESSAGE,
        );
      }

      const cost = costMap.get(item.productId);
      if (!cost) {
        throw new BadRequestException(
          `Missing product cost history for "${product.name}" on delivery date`,
        );
      }

      const sellingPrice = priceMap.get(item.productId) ?? product.defaultSellingPrice;
      const lineTotal = new Prisma.Decimal(sellingPrice).mul(item.quantityDelivered);
      const packagingUnitsOut = trackContainers
        ? packagingUnitsOutForDelivery(product, item.quantityDelivered, item.containersDelivered)
        : 0;
      resolvedItems.push({
        productId: item.productId,
        quantityDelivered: item.quantityDelivered,
        emptiesReceived: trackContainers ? rawEmpties : 0,
        containersDelivered: packagingUnitsOut,
        sellingPriceSnapshot: sellingPrice,
        unitCostSnapshot: cost,
        lineTotal,
        trackContainers,
        packagingUnitsOut,
      });
    }

    if (resolvedItems.length === 0) {
      throw new BadRequestException('At least one delivered or returned container is required');
    }

    const totalSales = resolvedItems.reduce(
      (sum, item) => sum.plus(item.lineTotal),
      new Prisma.Decimal(0),
    );
    const cashReceived = dto.cashReceived ?? 0;

    const deliveryId = await this.prisma.$transaction(
      async (tx) => {
        // Re-check run status inside tx so concurrent close cannot race.
        const openRun = await tx.deliveryRun.findFirst({
          where: { id: dto.deliveryRunId, tenantId, status: PrismaRunStatus.OPEN },
          select: { id: true, vehicleId: true },
        });
        if (!openRun) {
          throw new BadRequestException('Cannot add delivery to a closed run');
        }

        await this.assertFilledStockAvailable(
          tx,
          tenantId,
          dto.deliveryRunId,
          resolvedItems,
          productMap,
        );

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
            items: {
              create: resolvedItems.map((item) => ({
                tenantId,
                productId: item.productId,
                quantityDelivered: item.quantityDelivered,
                containersDelivered: item.containersDelivered,
                emptiesReceived: item.emptiesReceived,
                sellingPriceSnapshot: item.sellingPriceSnapshot,
                unitCostSnapshot: item.unitCostSnapshot,
                lineTotal: item.lineTotal,
              })),
            },
          },
          select: {
            id: true,
            items: {
              select: { id: true, productId: true, quantityDelivered: true, emptiesReceived: true },
            },
          },
        });

        const movements: Prisma.ContainerMovementCreateManyInput[] = [];
        const trackByProduct = new Map(
          resolvedItems.map((item) => [
            item.productId,
            { track: item.trackContainers, packagingUnitsOut: item.packagingUnitsOut },
          ]),
        );
        for (const createdItem of created.items) {
          const flags = trackByProduct.get(createdItem.productId);
          if (!flags?.track) continue;

          if (flags.packagingUnitsOut > 0) {
            movements.push({
              tenantId,
              productId: createdItem.productId,
              deliveryItemId: createdItem.id,
              customerId: dto.customerId,
              vehicleId: openRun.vehicleId,
              movementType: PrismaContainerMovementType.DELIVERED_TO_CUSTOMER,
              quantity: flags.packagingUnitsOut,
              notes: 'Delivery sale',
            });
          }
          if (createdItem.emptiesReceived > 0) {
            movements.push({
              tenantId,
              productId: createdItem.productId,
              deliveryItemId: createdItem.id,
              customerId: dto.customerId,
              vehicleId: openRun.vehicleId,
              movementType: PrismaContainerMovementType.RETURNED_FROM_CUSTOMER,
              quantity: createdItem.emptiesReceived,
              notes: 'Empty containers returned',
            });
          }
        }
        if (movements.length > 0) {
          await tx.containerMovement.createMany({ data: movements });
        }

        const ledgerEntries: Prisma.CustomerLedgerEntryCreateManyInput[] = [
          {
            tenantId,
            customerId: dto.customerId,
            entryType: PrismaLedgerEntryType.DELIVERY_SALE,
            amount: totalSales,
            referenceId: created.id,
            referenceType: 'delivery',
            notes: 'Delivery sale',
          },
        ];
        if (cashReceived > 0) {
          ledgerEntries.push({
            tenantId,
            customerId: dto.customerId,
            entryType: PrismaLedgerEntryType.PAYMENT,
            amount: new Prisma.Decimal(cashReceived).neg(),
            referenceId: created.id,
            referenceType: 'delivery',
            notes: 'Delivery cash received',
          });
        }
        await tx.customerLedgerEntry.createMany({ data: ledgerEntries });

        await tx.deliveryRun.update({
          where: { id: dto.deliveryRunId },
          data: {
            totalSales: { increment: totalSales },
            totalCashCollected: { increment: cashReceived },
          },
        });

        // Clear old promise if this delivery's cash (or full settle) covers it,
        // then optionally set a new promise from this stop.
        await clearPromisedDueIfSettled(tx, tenantId, dto.customerId);

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

        if (dto.plannedStopId) {
          await this.scheduling.completeStopInTx(tx, {
            tenantId,
            plannedStopId: dto.plannedStopId,
            deliveryId: created.id,
            customerId: dto.customerId,
            deliveryDate: parseDate(dto.deliveryDate),
          });
        }

        return created.id;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    const delivery = await this.prisma.delivery.findFirstOrThrow({
      where: { id: deliveryId, tenantId },
      include: this.detailInclude(),
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
    await this.prisma.$transaction(
      async (tx) => {
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

        await this.scheduling.revertStopOnDeliveryCancelInTx(tx, {
          tenantId,
          deliveryId: id,
          customerId: delivery.customerId,
        });
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    const cancelled = await this.prisma.delivery.findFirstOrThrow({
      where: { id, tenantId },
      include: this.detailInclude(),
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
    items: Array<{
      productId: string;
      quantityDelivered: number;
      packagingUnitsOut: number;
    }>,
    productMap: Map<string, { id: string; name: string }>,
  ): Promise<void> {
    const deliverItems = items.filter(
      (item) => item.quantityDelivered > 0 || item.packagingUnitsOut > 0,
    );
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
        select: { productId: true, filledCount: true, filledPackagingCount: true },
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
            select: {
              productId: true,
              quantityDelivered: true,
              containersDelivered: true,
            },
          },
        },
      }),
    ]);

    const openingFilled = new Map(
      openingStocks.map((row) => [row.productId, decimalQtyToNumber(row.filledCount)]),
    );
    const openingCans = new Map(
      openingStocks.map((row) => [row.productId, row.filledPackagingCount]),
    );
    const alreadyDelivered = new Map<string, number>();
    const alreadyCans = new Map<string, number>();
    for (const delivery of priorDeliveries) {
      for (const item of delivery.items) {
        alreadyDelivered.set(
          item.productId,
          (alreadyDelivered.get(item.productId) ?? 0) + decimalQtyToNumber(item.quantityDelivered),
        );
        alreadyCans.set(
          item.productId,
          (alreadyCans.get(item.productId) ?? 0) + item.containersDelivered,
        );
      }
    }

    const requestedQty = new Map<string, number>();
    const requestedCans = new Map<string, number>();
    for (const item of deliverItems) {
      requestedQty.set(
        item.productId,
        (requestedQty.get(item.productId) ?? 0) + item.quantityDelivered,
      );
      requestedCans.set(
        item.productId,
        (requestedCans.get(item.productId) ?? 0) + item.packagingUnitsOut,
      );
    }

    for (const [productId, qty] of requestedQty) {
      const opening = openingFilled.get(productId) ?? 0;
      const used = alreadyDelivered.get(productId) ?? 0;
      const available = opening - used;
      if (qty > available + 1e-9) {
        const name = productMap.get(productId)?.name ?? 'product';
        throw new BadRequestException(
          `Only ${available} units left on this run for "${name}" (opening ${opening}, already delivered ${used})`,
        );
      }
    }

    for (const [productId, cans] of requestedCans) {
      if (cans <= 0) continue;
      const opening = openingCans.get(productId) ?? 0;
      const used = alreadyCans.get(productId) ?? 0;
      const available = opening - used;
      if (cans > available) {
        const name = productMap.get(productId)?.name ?? 'product';
        throw new BadRequestException(
          `Only ${available} filled cans left on this run for "${name}" (opening ${opening}, already given ${used})`,
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
        .filter(
          (item) =>
            decimalQtyToNumber(item.quantityDelivered) > 0 ||
            item.containersDelivered > 0 ||
            item.emptiesReceived > 0,
        )
        .map((item) => {
          const qty = decimalQtyToNumber(item.quantityDelivered);
          const cans = item.containersDelivered > 0 ? ` / ${item.containersDelivered} cans` : '';
          return `${item.product.name} (${qty} del${cans} / ${item.emptiesReceived} empty)`;
        })
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
        quantityDelivered: decimalQtyToNumber(item.quantityDelivered),
        containersDelivered: item.containersDelivered,
        emptiesReceived: item.emptiesReceived,
        sellingPriceSnapshot: decimalToNumber(item.sellingPriceSnapshot),
        unitCostSnapshot: decimalToNumber(item.unitCostSnapshot),
        lineTotal: decimalToNumber(item.lineTotal),
        createdAt: item.createdAt,
      })),
    };
  }
}
