import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ContainerMovementType as PrismaContainerMovementType,
  LedgerEntryType as PrismaLedgerEntryType,
  OrderPaymentStatus as PrismaOrderPaymentStatus,
  OrderStatus as PrismaOrderStatus,
  PaymentMethod as PrismaPaymentMethod,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { clearPromisedDueIfSettled } from '../common/helpers/promised-due.helper';
import { assertOrdersEnabled } from '../common/helpers/orders.helper';
import { isInventoryEnabled } from '../common/helpers/inventory.helper';
import {
  computeOrderTotals,
  decimalToNumber,
  recomputeFulfillmentAfterDeliver,
  recomputePaymentStatus,
  roundMoney,
} from '../common/helpers/order-money.helper';
import { assertValidBaseQuantity } from '../common/helpers/product-qty.helper';
import {
  isReturnableContainersEnabled,
  packagingUnitsOutForDelivery,
  RETURNABLE_CONTAINERS_DISABLED_MESSAGE,
} from '../common/helpers/returnable-containers.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { OrderPaymentStatus, OrderStatus, PaymentMethod } from '../common/enums/delivery.enum';
import { InventoryService } from '../inventory/inventory.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderItemDto } from './dto/create-order-item.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { ReplaceOrderItemsDto } from './dto/replace-order-items.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { RecordOrderPaymentDto } from './dto/record-order-payment.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import {
  endOfTodayInTimeZoneUtc,
  parseCalendarDateUtc,
} from '../common/helpers/calendar-utc.helper';
import { getTenantTimezone } from '../common/helpers/tenant-timezone.helper';

/** Soft ref on StockMovement for Orders channel SALE_OUT. */
const ORDER_STOCK_REF = 'CustomerOrder';
const ORDER_SALE_OUT_REASON = 'Order sale';

type DbClient = Prisma.TransactionClient | PrismaService;

type ResolvedLine = {
  productId: string;
  quantity: number;
  unitPriceSnapshot: number;
  costSnapshot: number | null;
  lineDiscount: number;
  lineTotal: number;
  productName: string;
  containersDelivered: number;
};

/**
 * Orders channel — standalone from DeliveryRun / Delivery / PlannedStop.
 * Warehouse SALE_OUT on place when inventory ON (non-truck). No DeliveryRun FK in v1 —
 * if a future link exists, skip SALE_OUT so truck-loaded stock is not deducted twice.
 * Returnable packaging tracked when returnable-containers flag is ON.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * v1 detection: CustomerOrder has no DeliveryRun / Delivery FK → always non-truck.
   * Future: return true when order is assigned/fulfilled on a loaded delivery run.
   */
  private isFulfilledViaDeliveryRun(_order: { id: string }): boolean {
    return false;
  }

  async create(tenantId: string, dto: CreateOrderDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const lines = await this.resolveLines(tenantId, dto.customerId, dto.items, {
      requireCost: false,
    });
    const totals = computeOrderTotals({
      lines: lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPriceSnapshot,
        lineDiscount: l.lineDiscount,
      })),
      discountTotal: dto.discountTotal,
      deliveryCharges: dto.deliveryCharges,
    });

    const order = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await this.nextOrderNumber(tx, tenantId);
      const created = await tx.customerOrder.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          status: PrismaOrderStatus.DRAFT,
          paymentStatus: PrismaOrderPaymentStatus.UNPAID,
          orderNumber,
          subtotal: new Prisma.Decimal(totals.subtotal),
          discountTotal: new Prisma.Decimal(totals.discountTotal),
          deliveryCharges: new Prisma.Decimal(totals.deliveryCharges),
          total: new Prisma.Decimal(totals.total),
          amountPaid: new Prisma.Decimal(0),
          amountDue: new Prisma.Decimal(totals.total),
          shippingAddress: dto.shippingAddress?.trim() || null,
          shippingNotes: dto.shippingNotes?.trim() || null,
          internalNotes: dto.internalNotes?.trim() || null,
          preferredShipDate: dto.preferredShipDate
            ? this.parseDateOnly(dto.preferredShipDate)
            : null,
          createdById: actorId,
          items: {
            create: lines.map((line, i) => ({
              tenantId,
              productId: line.productId,
              quantity: new Prisma.Decimal(line.quantity),
              quantityDelivered: new Prisma.Decimal(0),
              containersDelivered: line.containersDelivered,
              emptiesReceived: 0,
              unitPriceSnapshot: new Prisma.Decimal(line.unitPriceSnapshot),
              costSnapshot:
                line.costSnapshot != null ? new Prisma.Decimal(line.costSnapshot) : null,
              lineDiscount: new Prisma.Decimal(line.lineDiscount),
              lineTotal: new Prisma.Decimal(totals.lineTotals[i]),
            })),
          },
          statusEvents: {
            create: {
              tenantId,
              fromStatus: null,
              toStatus: PrismaOrderStatus.DRAFT,
              byId: actorId,
              note: 'Order created',
            },
          },
        },
      });
      return created;
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'CREATE',
      entityId: order.id,
      newValue: {
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        total: totals.total,
        status: OrderStatus.DRAFT,
      },
    });

    return this.findOne(order.id, tenantId);
  }

  async list(
    tenantId: string,
    query: ListOrdersQueryDto,
  ): Promise<PaginatedData<ReturnType<OrdersService['toListItem']>>> {
    await assertOrdersEnabled(this.prisma, tenantId);

    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(tenantId, query);

    const [rows, total] = await Promise.all([
      this.prisma.customerOrder.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { orderNumber: 'desc' }],
        include: this.listInclude(),
      }),
      this.prisma.customerOrder.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const order = await this.prisma.customerOrder.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: this.detailInclude(),
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.toDetail(order);
  }

  async update(id: string, tenantId: string, dto: UpdateOrderDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId, { items: true });

    const isDraft = existing.status === PrismaOrderStatus.DRAFT;
    const placedPlus: PrismaOrderStatus[] = [
      PrismaOrderStatus.PLACED,
      PrismaOrderStatus.SHIPPED,
      PrismaOrderStatus.PARTIALLY_DELIVERED,
      PrismaOrderStatus.DELIVERED,
    ];
    const isPlacedPlus = placedPlus.includes(existing.status);

    if (!isDraft && !isPlacedPlus) {
      throw new BadRequestException('Order cannot be updated in its current status');
    }

    if (!isDraft) {
      const forbidden =
        dto.discountTotal !== undefined ||
        dto.deliveryCharges !== undefined ||
        dto.internalNotes !== undefined ||
        dto.preferredShipDate !== undefined;
      if (forbidden) {
        throw new BadRequestException(
          'Only shipping address/notes can be updated after the order is placed',
        );
      }
    }

    const nextDiscount = isDraft
      ? dto.discountTotal !== undefined
        ? dto.discountTotal
        : decimalToNumber(existing.discountTotal)
      : decimalToNumber(existing.discountTotal);
    const nextCharges = isDraft
      ? dto.deliveryCharges !== undefined
        ? dto.deliveryCharges
        : decimalToNumber(existing.deliveryCharges)
      : decimalToNumber(existing.deliveryCharges);

    let subtotal = decimalToNumber(existing.subtotal);
    let total = decimalToNumber(existing.total);
    let amountDue = decimalToNumber(existing.amountDue);
    let paymentStatus = existing.paymentStatus;

    if (isDraft && (dto.discountTotal !== undefined || dto.deliveryCharges !== undefined)) {
      const recomputed = computeOrderTotals({
        lines: existing.items.map((item) => ({
          quantity: decimalToNumber(item.quantity),
          unitPrice: decimalToNumber(item.unitPriceSnapshot),
          lineDiscount: decimalToNumber(item.lineDiscount),
        })),
        discountTotal: nextDiscount,
        deliveryCharges: nextCharges,
      });
      subtotal = recomputed.subtotal;
      total = recomputed.total;
      const amountPaid = decimalToNumber(existing.amountPaid);
      amountDue = roundMoney(Math.max(0, total - amountPaid));
      paymentStatus = recomputePaymentStatus(amountPaid, total);
    }

    await this.prisma.customerOrder.update({
      where: { id },
      data: {
        ...(isDraft && dto.discountTotal !== undefined
          ? { discountTotal: new Prisma.Decimal(nextDiscount) }
          : {}),
        ...(isDraft && dto.deliveryCharges !== undefined
          ? { deliveryCharges: new Prisma.Decimal(nextCharges) }
          : {}),
        ...(isDraft && (dto.discountTotal !== undefined || dto.deliveryCharges !== undefined)
          ? {
              subtotal: new Prisma.Decimal(subtotal),
              total: new Prisma.Decimal(total),
              amountDue: new Prisma.Decimal(amountDue),
              paymentStatus,
            }
          : {}),
        ...(dto.shippingAddress !== undefined
          ? { shippingAddress: dto.shippingAddress?.trim() || null }
          : {}),
        ...(dto.shippingNotes !== undefined
          ? { shippingNotes: dto.shippingNotes?.trim() || null }
          : {}),
        ...(isDraft && dto.internalNotes !== undefined
          ? { internalNotes: dto.internalNotes?.trim() || null }
          : {}),
        ...(isDraft && dto.preferredShipDate !== undefined
          ? {
              preferredShipDate: dto.preferredShipDate
                ? this.parseDateOnly(dto.preferredShipDate)
                : null,
            }
          : {}),
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'UPDATE',
      entityId: id,
      newValue: dto,
    });

    return this.findOne(id, tenantId);
  }

  async replaceItems(id: string, tenantId: string, dto: ReplaceOrderItemsDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId);
    if (existing.status !== PrismaOrderStatus.DRAFT) {
      throw new BadRequestException('Order lines can only be replaced while DRAFT');
    }

    const lines = await this.resolveLines(tenantId, existing.customerId, dto.items, {
      requireCost: false,
    });
    const totals = computeOrderTotals({
      lines: lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPriceSnapshot,
        lineDiscount: l.lineDiscount,
      })),
      discountTotal: decimalToNumber(existing.discountTotal),
      deliveryCharges: decimalToNumber(existing.deliveryCharges),
    });
    const amountPaid = decimalToNumber(existing.amountPaid);
    const amountDue = roundMoney(Math.max(0, totals.total - amountPaid));
    const paymentStatus = recomputePaymentStatus(amountPaid, totals.total);

    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id, tenantId } });
      await tx.orderItem.createMany({
        data: lines.map((line, i) => ({
          tenantId,
          orderId: id,
          productId: line.productId,
          quantity: new Prisma.Decimal(line.quantity),
          quantityDelivered: new Prisma.Decimal(0),
          containersDelivered: line.containersDelivered,
          emptiesReceived: 0,
          unitPriceSnapshot: new Prisma.Decimal(line.unitPriceSnapshot),
          costSnapshot: line.costSnapshot != null ? new Prisma.Decimal(line.costSnapshot) : null,
          lineDiscount: new Prisma.Decimal(line.lineDiscount),
          lineTotal: new Prisma.Decimal(totals.lineTotals[i]),
        })),
      });
      await tx.customerOrder.update({
        where: { id },
        data: {
          subtotal: new Prisma.Decimal(totals.subtotal),
          total: new Prisma.Decimal(totals.total),
          amountDue: new Prisma.Decimal(amountDue),
          paymentStatus,
        },
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'UPDATE',
      entityId: id,
      newValue: { itemsReplaced: true, total: totals.total },
    });

    return this.findOne(id, tenantId);
  }

  async place(id: string, tenantId: string, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId, { items: true });
    if (existing.status !== PrismaOrderStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT orders can be placed');
    }
    if (existing.items.length === 0) {
      throw new BadRequestException('Order has no items');
    }

    const tz = await getTenantTimezone(this.prisma, tenantId);
    const asOf = endOfTodayInTimeZoneUtc(tz);
    const productIds = existing.items.map((i) => i.productId);
    const [products, costRows] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, deletedAt: null, isActive: true, id: { in: productIds } },
        select: { id: true, name: true },
      }),
      this.prisma.productCostHistory.findMany({
        where: {
          tenantId,
          productId: { in: productIds },
          effectiveFrom: { lte: asOf },
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        select: { productId: true, costPerUnit: true },
      }),
    ]);
    const productMap = new Map(products.map((p) => [p.id, p]));
    const costMap = new Map<string, Prisma.Decimal>();
    for (const row of costRows) {
      if (!costMap.has(row.productId)) costMap.set(row.productId, row.costPerUnit);
    }

    for (const item of existing.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        throw new BadRequestException('One or more products are invalid for this workspace');
      }
      const cost = item.costSnapshot ?? costMap.get(item.productId) ?? null;
      if (cost == null) {
        throw new BadRequestException(
          `Missing product cost history for "${product.name}" — required to place order`,
        );
      }
    }

    const totals = computeOrderTotals({
      lines: existing.items.map((item) => ({
        quantity: decimalToNumber(item.quantity),
        unitPrice: decimalToNumber(item.unitPriceSnapshot),
        lineDiscount: decimalToNumber(item.lineDiscount),
      })),
      discountTotal: decimalToNumber(existing.discountTotal),
      deliveryCharges: decimalToNumber(existing.deliveryCharges),
    });
    const amountPaid = decimalToNumber(existing.amountPaid);
    const amountDue = roundMoney(Math.max(0, totals.total - amountPaid));
    const paymentStatus = recomputePaymentStatus(amountPaid, totals.total);

    const inventoryOn = await isInventoryEnabled(this.prisma, tenantId);
    const skipWarehouseSaleOut = !inventoryOn || this.isFulfilledViaDeliveryRun(existing);
    const saleLocation = !skipWarehouseSaleOut
      ? await this.inventory.ensureDefaultLocation(tenantId)
      : null;

    await this.prisma.$transaction(async (tx) => {
      for (const item of existing.items) {
        const cost = item.costSnapshot ?? costMap.get(item.productId)!;
        await tx.orderItem.update({
          where: { id: item.id },
          data: { costSnapshot: new Prisma.Decimal(cost) },
        });
      }

      await tx.customerOrder.update({
        where: { id },
        data: {
          status: PrismaOrderStatus.PLACED,
          subtotal: new Prisma.Decimal(totals.subtotal),
          total: new Prisma.Decimal(totals.total),
          amountDue: new Prisma.Decimal(amountDue),
          paymentStatus,
        },
      });

      // Post ORDER_SALE debit for order total (includes deliveryCharges).
      await tx.customerLedgerEntry.create({
        data: {
          tenantId,
          customerId: existing.customerId,
          entryType: PrismaLedgerEntryType.ORDER_SALE,
          amount: new Prisma.Decimal(totals.total),
          referenceId: id,
          referenceType: 'order',
          notes: `Order #${existing.orderNumber}`,
        },
      });

      // Non-truck path: warehouse SALE_OUT when inventory ON (not DeliveryRun load).
      if (!skipWarehouseSaleOut && saleLocation) {
        await this.postOrderSaleOut(tx, {
          tenantId,
          locationId: saleLocation.id,
          orderId: id,
          actorId,
          lines: existing.items.map((item) => ({
            productId: item.productId,
            qty: decimalToNumber(item.quantity),
            productName: productMap.get(item.productId)?.name,
          })),
        });
      }

      await this.writeStatusEvent(tx, {
        tenantId,
        orderId: id,
        fromStatus: PrismaOrderStatus.DRAFT,
        toStatus: PrismaOrderStatus.PLACED,
        byId: actorId,
        note: 'Order placed',
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'PLACE',
      entityId: id,
      oldValue: { status: OrderStatus.DRAFT },
      newValue: {
        status: OrderStatus.PLACED,
        total: totals.total,
        warehouseSaleOut: !skipWarehouseSaleOut,
        saleLocationId: saleLocation?.id ?? null,
      },
    });

    return this.findOne(id, tenantId);
  }

  async ship(id: string, tenantId: string, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId);
    if (existing.status !== PrismaOrderStatus.PLACED) {
      throw new BadRequestException('Only PLACED orders can be shipped');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.customerOrder.update({
        where: { id },
        data: { status: PrismaOrderStatus.SHIPPED },
      });
      await this.writeStatusEvent(tx, {
        tenantId,
        orderId: id,
        fromStatus: PrismaOrderStatus.PLACED,
        toStatus: PrismaOrderStatus.SHIPPED,
        byId: actorId,
        note: 'Order shipped',
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'SHIP',
      entityId: id,
      oldValue: { status: OrderStatus.PLACED },
      newValue: { status: OrderStatus.SHIPPED },
    });

    return this.findOne(id, tenantId);
  }

  /**
   * Deliver incremental quantities against SHIPPED / PARTIALLY_DELIVERED orders.
   * `quantityDelivered` in the body is ADDITIVE (this call's qty), not an absolute total.
   */
  async deliver(id: string, tenantId: string, dto: DeliverOrderDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId, { items: true });
    if (
      existing.status !== PrismaOrderStatus.SHIPPED &&
      existing.status !== PrismaOrderStatus.PARTIALLY_DELIVERED
    ) {
      throw new BadRequestException(
        'Only SHIPPED or PARTIALLY_DELIVERED orders can record deliveries',
      );
    }

    const containersEnabled = await isReturnableContainersEnabled(this.prisma, tenantId);
    const productIds = existing.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, deletedAt: null },
      select: {
        id: true,
        name: true,
        baseUnit: true,
        isReturnable: true,
        allowFractionalQty: true,
        containerCapacity: true,
      },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const itemByProduct = new Map(existing.items.map((i) => [i.productId, i]));
    type Increment = {
      quantityDelivered: number;
      containersDelivered: number;
      emptiesReceived: number;
    };
    const increments = new Map<string, Increment>();

    for (const row of dto.items) {
      const item = itemByProduct.get(row.productId);
      if (!item) {
        throw new BadRequestException(`Product ${row.productId} is not on this order`);
      }

      const product = productMap.get(row.productId);
      if (!product) {
        throw new BadRequestException(`Product ${row.productId} not found`);
      }
      assertValidBaseQuantity(row.quantityDelivered, product);

      const trackContainers = containersEnabled && product.isReturnable;
      const rawEmpties = row.emptiesReceived ?? 0;
      if (!trackContainers && rawEmpties > 0) {
        throw new BadRequestException(
          containersEnabled
            ? `Empties are not tracked for non-returnable product "${product.name}"`
            : RETURNABLE_CONTAINERS_DISABLED_MESSAGE,
        );
      }
      if (!trackContainers && (row.containersDelivered ?? 0) > 0) {
        throw new BadRequestException(
          containersEnabled
            ? `Containers are not tracked for non-returnable product "${product.name}"`
            : RETURNABLE_CONTAINERS_DISABLED_MESSAGE,
        );
      }

      const packagingUnitsOut = trackContainers
        ? packagingUnitsOutForDelivery(product, row.quantityDelivered, row.containersDelivered)
        : 0;

      const prev = increments.get(row.productId) ?? {
        quantityDelivered: 0,
        containersDelivered: 0,
        emptiesReceived: 0,
      };
      increments.set(row.productId, {
        quantityDelivered: prev.quantityDelivered + row.quantityDelivered,
        containersDelivered: prev.containersDelivered + packagingUnitsOut,
        emptiesReceived: prev.emptiesReceived + (trackContainers ? rawEmpties : 0),
      });
    }

    const nextDelivered: Array<{ id: string; quantity: number; quantityDelivered: number }> = [];
    const lineUpdates: Array<{
      id: string;
      productId: string;
      quantityDelivered: number;
      containersDelivered: number;
      emptiesReceived: number;
      packagingUnitsOut: number;
      emptiesThisCall: number;
      trackContainers: boolean;
    }> = [];

    for (const item of existing.items) {
      const add = increments.get(item.productId);
      const product = productMap.get(item.productId)!;
      const ordered = decimalToNumber(item.quantity);
      const currentQty = decimalToNumber(item.quantityDelivered);
      const addQty = add?.quantityDelivered ?? 0;
      const nextQty = currentQty + addQty;
      if (nextQty > ordered + 0.00001) {
        throw new BadRequestException(
          `Delivered quantity cannot exceed ordered quantity for product ${item.productId}`,
        );
      }
      nextDelivered.push({ id: item.id, quantity: ordered, quantityDelivered: nextQty });

      if (!add || addQty <= 0) continue;

      const trackContainers = containersEnabled && product.isReturnable;
      // First handoff: replace planned cans with actual; later handoffs accumulate.
      const nextCans =
        currentQty === 0
          ? add.containersDelivered
          : item.containersDelivered + add.containersDelivered;
      const nextEmpties = item.emptiesReceived + add.emptiesReceived;

      lineUpdates.push({
        id: item.id,
        productId: item.productId,
        quantityDelivered: nextQty,
        containersDelivered: nextCans,
        emptiesReceived: nextEmpties,
        packagingUnitsOut: add.containersDelivered,
        emptiesThisCall: add.emptiesReceived,
        trackContainers,
      });
    }

    const toStatus = recomputeFulfillmentAfterDeliver(
      nextDelivered,
      existing.status as PrismaOrderStatus,
    );

    await this.prisma.$transaction(async (tx) => {
      for (const row of lineUpdates) {
        await tx.orderItem.update({
          where: { id: row.id },
          data: {
            quantityDelivered: new Prisma.Decimal(row.quantityDelivered),
            containersDelivered: row.containersDelivered,
            emptiesReceived: row.emptiesReceived,
          },
        });
      }

      const movements: Prisma.ContainerMovementCreateManyInput[] = [];
      for (const row of lineUpdates) {
        if (!row.trackContainers) continue;
        if (row.packagingUnitsOut > 0) {
          movements.push({
            tenantId,
            productId: row.productId,
            customerId: existing.customerId,
            movementType: PrismaContainerMovementType.DELIVERED_TO_CUSTOMER,
            quantity: row.packagingUnitsOut,
            notes: `Order #${existing.orderNumber} delivery`,
          });
        }
        if (row.emptiesThisCall > 0) {
          movements.push({
            tenantId,
            productId: row.productId,
            customerId: existing.customerId,
            movementType: PrismaContainerMovementType.RETURNED_FROM_CUSTOMER,
            quantity: row.emptiesThisCall,
            notes: `Order #${existing.orderNumber} empties`,
          });
        }
      }
      if (movements.length > 0) {
        await tx.containerMovement.createMany({ data: movements });
      }

      if (toStatus !== existing.status) {
        await tx.customerOrder.update({
          where: { id },
          data: { status: toStatus },
        });
        await this.writeStatusEvent(tx, {
          tenantId,
          orderId: id,
          fromStatus: existing.status,
          toStatus,
          byId: actorId,
          note: 'Delivery recorded',
        });
      }
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'DELIVER',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: {
        status: toStatus,
        increments: Object.fromEntries(
          [...increments.entries()].map(([productId, inc]) => [productId, inc]),
        ),
      },
    });

    return this.findOne(id, tenantId);
  }

  async cancel(id: string, tenantId: string, dto: CancelOrderDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId);
    if (
      existing.status !== PrismaOrderStatus.DRAFT &&
      existing.status !== PrismaOrderStatus.PLACED
    ) {
      throw new BadRequestException('Only DRAFT or PLACED orders can be cancelled');
    }
    if (decimalToNumber(existing.amountPaid) > 0) {
      throw new BadRequestException('Cannot cancel an order with payments — refund first');
    }

    const fromStatus = existing.status;

    await this.prisma.$transaction(async (tx) => {
      if (fromStatus === PrismaOrderStatus.PLACED) {
        const saleEntries = await tx.customerLedgerEntry.findMany({
          where: {
            tenantId,
            referenceId: id,
            referenceType: 'order',
            entryType: PrismaLedgerEntryType.ORDER_SALE,
          },
        });
        if (saleEntries.length > 0) {
          await tx.customerLedgerEntry.createMany({
            data: saleEntries.map((entry) => ({
              tenantId,
              customerId: entry.customerId,
              entryType: PrismaLedgerEntryType.ADJUSTMENT,
              amount: new Prisma.Decimal(entry.amount).neg(),
              referenceId: id,
              referenceType: 'order',
              notes: `Cancel reversal for ${entry.entryType}`,
            })),
          });
        }

        // Reverse warehouse SALE_OUT posted at place (inventory ON).
        await this.reverseOrderSaleOut(tx, tenantId, id);
      }

      await tx.customerOrder.update({
        where: { id },
        data: {
          status: PrismaOrderStatus.CANCELLED,
          cancelReason: dto.reason,
          cancelledAt: new Date(),
          cancelledById: actorId,
        },
      });

      await this.writeStatusEvent(tx, {
        tenantId,
        orderId: id,
        fromStatus,
        toStatus: PrismaOrderStatus.CANCELLED,
        byId: actorId,
        note: dto.reason,
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'CANCEL',
      entityId: id,
      oldValue: { status: fromStatus },
      newValue: {
        status: OrderStatus.CANCELLED,
        reason: dto.reason,
        warehouseSaleOutReversed: fromStatus === PrismaOrderStatus.PLACED,
      },
    });

    return this.findOne(id, tenantId);
  }

  async recordPayment(id: string, tenantId: string, dto: RecordOrderPaymentDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId);
    const payableStatuses: PrismaOrderStatus[] = [
      PrismaOrderStatus.PLACED,
      PrismaOrderStatus.SHIPPED,
      PrismaOrderStatus.PARTIALLY_DELIVERED,
      PrismaOrderStatus.DELIVERED,
    ];
    if (!payableStatuses.includes(existing.status as PrismaOrderStatus)) {
      throw new BadRequestException('Payments can only be recorded on open placed orders');
    }

    const amountPaid = decimalToNumber(existing.amountPaid);
    const total = decimalToNumber(existing.total);
    const amountDue = roundMoney(Math.max(0, total - amountPaid));
    if (dto.amount > amountDue + 0.00001) {
      throw new BadRequestException('Payment amount exceeds amount due');
    }

    const nextPaid = roundMoney(amountPaid + dto.amount);
    const nextDue = roundMoney(Math.max(0, total - nextPaid));
    const paymentStatus = recomputePaymentStatus(nextPaid, total);
    const paidAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          customerId: existing.customerId,
          amount: new Prisma.Decimal(dto.amount),
          paymentDate: paidAt,
          method: dto.method as PrismaPaymentMethod,
          collectedById: actorId,
          reference: `ORD-${existing.orderNumber}`,
          notes: `Order #${existing.orderNumber} payment`,
        },
      });

      await tx.customerLedgerEntry.create({
        data: {
          tenantId,
          customerId: existing.customerId,
          entryType: PrismaLedgerEntryType.PAYMENT,
          amount: new Prisma.Decimal(dto.amount).neg(),
          referenceId: payment.id,
          referenceType: 'payment',
          notes: `Order #${existing.orderNumber} payment`,
        },
      });

      await tx.orderPayment.create({
        data: {
          tenantId,
          orderId: id,
          paymentId: payment.id,
          method: dto.method as PrismaPaymentMethod,
          amount: new Prisma.Decimal(dto.amount),
          paidAt,
          createdById: actorId,
        },
      });

      await tx.customerOrder.update({
        where: { id },
        data: {
          amountPaid: new Prisma.Decimal(nextPaid),
          amountDue: new Prisma.Decimal(nextDue),
          paymentStatus,
        },
      });

      await clearPromisedDueIfSettled(tx, tenantId, existing.customerId);
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'PAYMENT',
      entityId: id,
      newValue: {
        method: dto.method,
        amount: dto.amount,
        amountPaid: nextPaid,
        paymentStatus,
      },
    });

    return this.findOne(id, tenantId);
  }

  /**
   * v1 FULL refund only: amount must equal amountPaid.
   * Reverses ORDER_SALE + order PAYMENT ledger rows via ADJUSTMENT (same pattern as delivery cancel).
   */
  async refund(id: string, tenantId: string, dto: RefundOrderDto, actorId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const existing = await this.requireOrder(id, tenantId, { payments: true });
    const refundable: PrismaOrderStatus[] = [
      PrismaOrderStatus.PLACED,
      PrismaOrderStatus.SHIPPED,
      PrismaOrderStatus.PARTIALLY_DELIVERED,
      PrismaOrderStatus.DELIVERED,
    ];
    if (!refundable.includes(existing.status as PrismaOrderStatus)) {
      throw new BadRequestException('Order cannot be refunded in its current status');
    }

    const amountPaid = roundMoney(decimalToNumber(existing.amountPaid));
    if (amountPaid <= 0) {
      throw new BadRequestException('Order has no payments to refund');
    }
    if (roundMoney(dto.amount) !== amountPaid) {
      throw new BadRequestException(
        `v1 supports full refund only — amount must equal amountPaid (${amountPaid})`,
      );
    }

    const fromStatus = existing.status;
    const paymentIds = existing.payments
      .map((p) => p.paymentId)
      .filter((pid): pid is string => !!pid);

    await this.prisma.$transaction(async (tx) => {
      const saleEntries = await tx.customerLedgerEntry.findMany({
        where: {
          tenantId,
          referenceId: id,
          referenceType: 'order',
          entryType: PrismaLedgerEntryType.ORDER_SALE,
        },
      });

      const paymentEntries =
        paymentIds.length > 0
          ? await tx.customerLedgerEntry.findMany({
              where: {
                tenantId,
                referenceType: 'payment',
                referenceId: { in: paymentIds },
                entryType: PrismaLedgerEntryType.PAYMENT,
              },
            })
          : [];

      const toReverse = [...saleEntries, ...paymentEntries];
      if (toReverse.length > 0) {
        await tx.customerLedgerEntry.createMany({
          data: toReverse.map((entry) => ({
            tenantId,
            customerId: entry.customerId,
            entryType: PrismaLedgerEntryType.ADJUSTMENT,
            amount: new Prisma.Decimal(entry.amount).neg(),
            referenceId: entry.referenceId,
            referenceType: entry.referenceType,
            notes: `Refund reversal for ${entry.entryType} (order #${existing.orderNumber})`,
          })),
        });
      }

      await tx.customerOrder.update({
        where: { id },
        data: {
          status: PrismaOrderStatus.REFUNDED,
          amountPaid: new Prisma.Decimal(0),
          amountDue: new Prisma.Decimal(0),
          paymentStatus: PrismaOrderPaymentStatus.UNPAID,
          refundReason: dto.reason,
          refundedAt: new Date(),
          refundedById: actorId,
          refundAmount: new Prisma.Decimal(amountPaid),
        },
      });

      await this.writeStatusEvent(tx, {
        tenantId,
        orderId: id,
        fromStatus,
        toStatus: PrismaOrderStatus.REFUNDED,
        byId: actorId,
        note: dto.reason,
      });

      await clearPromisedDueIfSettled(tx, tenantId, existing.customerId);
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'orders',
      action: 'REFUND',
      entityId: id,
      oldValue: { status: fromStatus, amountPaid },
      newValue: { status: OrderStatus.REFUNDED, refundAmount: amountPaid, reason: dto.reason },
    });

    return this.findOne(id, tenantId);
  }

  async timeline(id: string, tenantId: string) {
    await assertOrdersEnabled(this.prisma, tenantId);

    const order = await this.prisma.customerOrder.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const events = await this.prisma.orderStatusEvent.findMany({
      where: { tenantId, orderId: id },
      orderBy: { at: 'asc' },
      include: {
        by: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    return events.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus as OrderStatus | null,
      toStatus: e.toStatus as OrderStatus,
      at: e.at,
      note: e.note,
      by: e.by,
    }));
  }

  // ─── helpers ───────────────────────────────────────────────

  private async requireOrder(
    id: string,
    tenantId: string,
    include?: { items?: boolean; payments?: boolean },
  ) {
    const order = await this.prisma.customerOrder.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        items: include?.items === true,
        payments: include?.payments === true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async nextOrderNumber(tx: DbClient, tenantId: string): Promise<number> {
    const agg = await tx.customerOrder.aggregate({
      where: { tenantId },
      _max: { orderNumber: true },
    });
    return (agg._max.orderNumber ?? 0) + 1;
  }

  private async resolveLines(
    tenantId: string,
    customerId: string,
    items: CreateOrderItemDto[],
    opts: { requireCost: boolean },
  ): Promise<ResolvedLine[]> {
    const productIds = items.map((i) => i.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException('Duplicate products in order lines are not allowed');
    }

    const tz = await getTenantTimezone(this.prisma, tenantId);
    const asOf = endOfTodayInTimeZoneUtc(tz);
    const containersEnabled = await isReturnableContainersEnabled(this.prisma, tenantId);
    const [products, prices, costRows] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, deletedAt: null, isActive: true, id: { in: productIds } },
        select: {
          id: true,
          name: true,
          defaultSellingPrice: true,
          allowFractionalQty: true,
          baseUnit: true,
          isReturnable: true,
          containerCapacity: true,
        },
      }),
      this.prisma.customerProductPrice.findMany({
        where: { tenantId, customerId, productId: { in: productIds } },
        select: { productId: true, pricePerUnit: true },
      }),
      this.prisma.productCostHistory.findMany({
        where: {
          tenantId,
          productId: { in: productIds },
          effectiveFrom: { lte: asOf },
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        select: { productId: true, costPerUnit: true },
      }),
    ]);

    if (products.length !== productIds.length) {
      throw new BadRequestException('One or more products are invalid for this workspace');
    }

    const productMap = new Map(products.map((p) => [p.id, p]));
    const priceMap = new Map(prices.map((p) => [p.productId, p.pricePerUnit]));
    const costMap = new Map<string, number>();
    for (const row of costRows) {
      if (!costMap.has(row.productId)) {
        costMap.set(row.productId, decimalToNumber(row.costPerUnit));
      }
    }

    const resolved: ResolvedLine[] = [];
    for (const item of items) {
      const product = productMap.get(item.productId)!;
      assertValidBaseQuantity(item.quantity, product);

      const rawCans = item.containersDelivered ?? 0;
      if (!containersEnabled && rawCans > 0) {
        throw new BadRequestException(RETURNABLE_CONTAINERS_DISABLED_MESSAGE);
      }
      if (containersEnabled && !product.isReturnable && rawCans > 0) {
        throw new BadRequestException(
          `Containers are not tracked for non-returnable product "${product.name}"`,
        );
      }

      let containersDelivered = 0;
      if (containersEnabled && product.isReturnable) {
        containersDelivered = packagingUnitsOutForDelivery(
          product,
          item.quantity,
          item.containersDelivered,
        );
      }

      const unitPrice =
        item.unitPrice !== undefined
          ? item.unitPrice
          : decimalToNumber(priceMap.get(item.productId) ?? product.defaultSellingPrice);
      const costSnapshot = costMap.has(item.productId) ? costMap.get(item.productId)! : null;
      if (opts.requireCost && costSnapshot == null) {
        throw new BadRequestException(`Missing product cost history for "${product.name}"`);
      }

      const lineDiscount = item.lineDiscount ?? 0;
      const lineTotal = roundMoney(Math.max(0, item.quantity * unitPrice - lineDiscount));
      resolved.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceSnapshot: roundMoney(unitPrice),
        costSnapshot,
        lineDiscount: roundMoney(lineDiscount),
        lineTotal,
        productName: product.name,
        containersDelivered,
      });
    }
    return resolved;
  }

  /** Aggregate qty by product and post SALE_OUT (signed negative). Reject short stock. */
  private async postOrderSaleOut(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      orderId: string;
      actorId: string;
      lines: Array<{ productId: string; qty: number; productName?: string }>;
    },
  ) {
    const qtyByProduct = new Map<string, { qty: number; name: string }>();
    for (const line of args.lines) {
      if (!(line.qty > 0)) continue;
      const prev = qtyByProduct.get(line.productId);
      qtyByProduct.set(line.productId, {
        qty: (prev?.qty ?? 0) + line.qty,
        name: line.productName ?? prev?.name ?? 'product',
      });
    }

    for (const [productId, { qty, name }] of qtyByProduct) {
      const dec = new Prisma.Decimal(qty);
      const balance = await tx.stockBalance.findUnique({
        where: {
          tenantId_locationId_productId: {
            tenantId: args.tenantId,
            locationId: args.locationId,
            productId,
          },
        },
      });
      const current = balance ? new Prisma.Decimal(balance.quantity) : new Prisma.Decimal(0);
      const next = current.sub(dec);
      if (next.lessThan(0)) {
        throw new BadRequestException(
          `Cannot place order — only ${decimalToNumber(current)} available for "${name}" at warehouse`,
        );
      }

      if (balance) {
        await tx.stockBalance.update({
          where: { id: balance.id },
          data: { quantity: next },
        });
      } else {
        await tx.stockBalance.create({
          data: {
            tenantId: args.tenantId,
            locationId: args.locationId,
            productId,
            quantity: next,
          },
        });
      }

      await tx.stockMovement.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          productId,
          type: StockMovementType.SALE_OUT,
          quantity: dec.neg(),
          reason: ORDER_SALE_OUT_REASON,
          referenceType: ORDER_STOCK_REF,
          referenceId: args.orderId,
          createdByUserId: args.actorId,
        },
      });
    }
  }

  /** Restore balances and remove SALE_OUT rows for a cancelled PLACED order. */
  private async reverseOrderSaleOut(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const outs = await tx.stockMovement.findMany({
      where: {
        tenantId,
        referenceType: ORDER_STOCK_REF,
        referenceId: orderId,
        type: StockMovementType.SALE_OUT,
      },
    });

    for (const m of outs) {
      const restore = new Prisma.Decimal(m.quantity).neg();
      const balance = await tx.stockBalance.findUnique({
        where: {
          tenantId_locationId_productId: {
            tenantId,
            locationId: m.locationId,
            productId: m.productId,
          },
        },
      });
      const current = balance ? new Prisma.Decimal(balance.quantity) : new Prisma.Decimal(0);
      const next = current.add(restore);

      if (balance) {
        await tx.stockBalance.update({
          where: { id: balance.id },
          data: { quantity: next },
        });
      } else {
        await tx.stockBalance.create({
          data: {
            tenantId,
            locationId: m.locationId,
            productId: m.productId,
            quantity: next,
          },
        });
      }

      await tx.stockMovement.delete({ where: { id: m.id } });
    }
  }

  private async writeStatusEvent(
    tx: DbClient,
    data: {
      tenantId: string;
      orderId: string;
      fromStatus: PrismaOrderStatus | null;
      toStatus: PrismaOrderStatus;
      byId: string;
      note?: string;
    },
  ) {
    await tx.orderStatusEvent.create({
      data: {
        tenantId: data.tenantId,
        orderId: data.orderId,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        byId: data.byId,
        note: data.note ?? null,
      },
    });
  }

  private buildWhere(tenantId: string, query: ListOrdersQueryDto): Prisma.CustomerOrderWhereInput {
    const where: Prisma.CustomerOrderWhereInput = { tenantId, deletedAt: null };

    if (query.status) where.status = query.status as PrismaOrderStatus;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus as PrismaOrderPaymentStatus;
    if (query.customerId) where.customerId = query.customerId;

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = this.parseDate(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = this.endOfDay(query.dateTo);
    }

    const search = query.search?.trim();
    if (search) {
      const asNumber = Number(search);
      const or: Prisma.CustomerOrderWhereInput[] = [
        { customer: { name: { contains: search } } },
        { customer: { phone: { contains: search } } },
      ];
      if (Number.isInteger(asNumber) && asNumber > 0) {
        or.push({ orderNumber: asNumber });
      }
      where.OR = or;
    }

    return where;
  }

  private parseDate(value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return parsed;
  }

  private parseDateOnly(value: string): Date {
    const d = parseCalendarDateUtc(value, false);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  private endOfDay(value: string): Date {
    const d = parseCalendarDateUtc(value, true);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  private startOfDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  }

  private listInclude() {
    return {
      customer: { select: { id: true, name: true, phone: true } },
      createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      _count: { select: { items: true } },
    } as const;
  }

  private detailInclude() {
    return {
      customer: { select: { id: true, name: true, phone: true } },
      createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      cancelledBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      refundedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              baseUnit: true,
              allowFractionalQty: true,
              isReturnable: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' as const },
      },
      payments: {
        orderBy: { paidAt: 'asc' as const },
      },
    } as const;
  }

  private toListItem(row: {
    id: string;
    tenantId: string;
    customerId: string;
    status: PrismaOrderStatus;
    paymentStatus: PrismaOrderPaymentStatus;
    orderNumber: number;
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    deliveryCharges: Prisma.Decimal;
    total: Prisma.Decimal;
    amountPaid: Prisma.Decimal;
    amountDue: Prisma.Decimal;
    preferredShipDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
    customer: { id: string; name: string; phone: string };
    createdBy: { id: string; firstName: string; lastName: string; email: string };
    _count: { items: number };
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      status: row.status as OrderStatus,
      paymentStatus: row.paymentStatus as OrderPaymentStatus,
      orderNumber: row.orderNumber,
      subtotal: decimalToNumber(row.subtotal),
      discountTotal: decimalToNumber(row.discountTotal),
      deliveryCharges: decimalToNumber(row.deliveryCharges),
      total: decimalToNumber(row.total),
      amountPaid: decimalToNumber(row.amountPaid),
      amountDue: decimalToNumber(row.amountDue),
      preferredShipDate: row.preferredShipDate
        ? row.preferredShipDate.toISOString().slice(0, 10)
        : null,
      itemCount: row._count.items,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      customer: row.customer,
      createdBy: row.createdBy,
    };
  }

  private toDetail(row: {
    id: string;
    tenantId: string;
    customerId: string;
    status: PrismaOrderStatus;
    paymentStatus: PrismaOrderPaymentStatus;
    orderNumber: number;
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    deliveryCharges: Prisma.Decimal;
    total: Prisma.Decimal;
    amountPaid: Prisma.Decimal;
    amountDue: Prisma.Decimal;
    shippingAddress: string | null;
    shippingNotes: string | null;
    internalNotes: string | null;
    preferredShipDate: Date | null;
    cancelReason: string | null;
    cancelledAt: Date | null;
    cancelledById: string | null;
    refundReason: string | null;
    refundedAt: Date | null;
    refundedById: string | null;
    refundAmount: Prisma.Decimal | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    customer: { id: string; name: string; phone: string };
    createdBy: { id: string; firstName: string; lastName: string; email: string };
    cancelledBy: { id: string; firstName: string; lastName: string; email: string } | null;
    refundedBy: { id: string; firstName: string; lastName: string; email: string } | null;
    items: Array<{
      id: string;
      productId: string;
      quantity: Prisma.Decimal;
      quantityDelivered: Prisma.Decimal;
      containersDelivered: number;
      emptiesReceived: number;
      unitPriceSnapshot: Prisma.Decimal;
      costSnapshot: Prisma.Decimal | null;
      lineDiscount: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
      product: {
        id: string;
        name: string;
        sku: string | null;
        baseUnit: string;
        allowFractionalQty: boolean;
        isReturnable: boolean;
      };
    }>;
    payments: Array<{
      id: string;
      paymentId: string | null;
      method: PrismaPaymentMethod;
      amount: Prisma.Decimal;
      paidAt: Date;
      createdById: string | null;
      createdAt: Date;
    }>;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      status: row.status as OrderStatus,
      paymentStatus: row.paymentStatus as OrderPaymentStatus,
      orderNumber: row.orderNumber,
      subtotal: decimalToNumber(row.subtotal),
      discountTotal: decimalToNumber(row.discountTotal),
      deliveryCharges: decimalToNumber(row.deliveryCharges),
      total: decimalToNumber(row.total),
      amountPaid: decimalToNumber(row.amountPaid),
      amountDue: decimalToNumber(row.amountDue),
      shippingAddress: row.shippingAddress,
      shippingNotes: row.shippingNotes,
      internalNotes: row.internalNotes,
      preferredShipDate: row.preferredShipDate
        ? row.preferredShipDate.toISOString().slice(0, 10)
        : null,
      cancelReason: row.cancelReason,
      cancelledAt: row.cancelledAt,
      cancelledById: row.cancelledById,
      refundReason: row.refundReason,
      refundedAt: row.refundedAt,
      refundedById: row.refundedById,
      refundAmount: row.refundAmount != null ? decimalToNumber(row.refundAmount) : null,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      customer: row.customer,
      createdBy: row.createdBy,
      cancelledBy: row.cancelledBy,
      refundedBy: row.refundedBy,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: decimalToNumber(item.quantity),
        quantityDelivered: decimalToNumber(item.quantityDelivered),
        containersDelivered: item.containersDelivered,
        emptiesReceived: item.emptiesReceived,
        unitPriceSnapshot: decimalToNumber(item.unitPriceSnapshot),
        costSnapshot: item.costSnapshot != null ? decimalToNumber(item.costSnapshot) : null,
        lineDiscount: decimalToNumber(item.lineDiscount),
        lineTotal: decimalToNumber(item.lineTotal),
        product: item.product,
      })),
      payments: row.payments.map((p) => ({
        id: p.id,
        paymentId: p.paymentId,
        method: p.method as PaymentMethod,
        amount: decimalToNumber(p.amount),
        paidAt: p.paidAt,
        createdById: p.createdById,
        createdAt: p.createdAt,
      })),
    };
  }
}
