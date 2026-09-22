import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryStatus as PrismaDeliveryStatus,
  Prisma,
  RunStatus as PrismaRunStatus,
  StockType as PrismaStockType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { RunStatus, StockType } from '../common/enums/delivery.enum';
import { CreateDeliveryRunDto } from './dto/create-delivery-run.dto';
import { CloseDeliveryRunDto } from './dto/close-delivery-run.dto';
import { UpdateDeliveryRunDto } from './dto/update-delivery-run.dto';
import { ListDeliveryRunsQueryDto } from './dto/list-delivery-runs-query.dto';
import { DeliveryRunStockDto } from './dto/delivery-run-stock.dto';

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

@Injectable()
export class DeliveryRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(tenantId: string, dto: CreateDeliveryRunDto, actorId: string) {
    this.assertUniqueProducts(dto.openingStock);
    const date = parseDate(dto.date);

    const run = await this.prisma.$transaction(async (tx) => {
      await Promise.all([
        this.assertRider(tx, tenantId, dto.riderId),
        this.assertVehicle(tx, tenantId, dto.vehicleId),
        this.assertProducts(
          tx,
          tenantId,
          dto.openingStock.map((stock) => stock.productId),
        ),
      ]);

      return tx.deliveryRun.create({
        data: {
          tenantId,
          riderId: dto.riderId,
          vehicleId: dto.vehicleId,
          date,
          openingCash: dto.openingCash,
          notes: dto.notes?.trim() || null,
          stocks: {
            create: dto.openingStock.map((stock) => ({
              tenantId,
              productId: stock.productId,
              stockType: PrismaStockType.OPENING,
              filledCount: stock.filledCount,
              emptyCount: stock.emptyCount,
            })),
          },
        },
        include: this.detailInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveryruns',
      action: 'CREATE',
      entityId: run.id,
      newValue: { riderId: run.riderId, vehicleId: run.vehicleId, date: run.date },
    });

    return this.toDetail(run);
  }

  async list(
    tenantId: string,
    query: ListDeliveryRunsQueryDto,
  ): Promise<PaginatedData<ReturnType<DeliveryRunsService['toListItem']>>> {
    const { skip, take } = getPaginationParams(query);
    const where: Prisma.DeliveryRunWhereInput = { tenantId };

    if (query.riderId) where.riderId = query.riderId;
    if (query.status) where.status = query.status as unknown as PrismaRunStatus;
    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = parseDate(query.dateFrom);
      if (query.dateTo) where.date.lte = endOfDay(query.dateTo);
    }

    const [rows, total] = await Promise.all([
      this.prisma.deliveryRun.findMany({
        where,
        skip,
        take,
        orderBy: { date: 'desc' },
        include: {
          rider: { select: { id: true, firstName: true, lastName: true, email: true } },
          vehicle: { select: { id: true, name: true, plateNumber: true } },
          _count: { select: { deliveries: true } },
        },
      }),
      this.prisma.deliveryRun.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id, tenantId },
      include: this.detailInclude(),
    });
    if (!run) throw new NotFoundException('Delivery run not found');
    return this.toDetail(run);
  }

  async update(id: string, tenantId: string, dto: UpdateDeliveryRunDto, actorId: string) {
    if (dto.openingCash == null && !dto.openingStock && dto.notes === undefined) {
      throw new BadRequestException('Nothing to update');
    }
    if (dto.openingStock) this.assertUniqueProducts(dto.openingStock);

    const updated = await this.prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findFirst({
        where: { id, tenantId },
        select: { id: true, status: true },
      });
      if (!run) throw new NotFoundException('Delivery run not found');
      if (run.status !== PrismaRunStatus.OPEN) {
        throw new BadRequestException('Only open delivery runs can be edited');
      }

      if (dto.openingStock) {
        await this.assertProducts(
          tx,
          tenantId,
          dto.openingStock.map((stock) => stock.productId),
        );
        await this.assertOpeningStockNotBelowDelivered(tx, tenantId, id, dto.openingStock);

        for (const stock of dto.openingStock) {
          await tx.deliveryRunStock.upsert({
            where: {
              deliveryRunId_productId_stockType: {
                deliveryRunId: id,
                productId: stock.productId,
                stockType: PrismaStockType.OPENING,
              },
            },
            create: {
              tenantId,
              deliveryRunId: id,
              productId: stock.productId,
              stockType: PrismaStockType.OPENING,
              filledCount: stock.filledCount,
              emptyCount: stock.emptyCount,
            },
            update: {
              filledCount: stock.filledCount,
              emptyCount: stock.emptyCount,
            },
          });
        }
      }

      await tx.deliveryRun.update({
        where: { id },
        data: {
          ...(dto.openingCash != null ? { openingCash: dto.openingCash } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        },
      });

      return tx.deliveryRun.findFirstOrThrow({
        where: { id, tenantId },
        include: this.detailInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveryruns',
      action: 'UPDATE',
      entityId: id,
      newValue: {
        openingCash: dto.openingCash,
        openingStock: dto.openingStock,
        notes: dto.notes,
      },
    });

    return this.toDetail(updated);
  }

  async close(id: string, tenantId: string, dto: CloseDeliveryRunDto, actorId: string) {
    this.assertUniqueProducts(dto.closingStock);

    const closed = await this.prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findFirst({
        where: { id, tenantId },
        select: { id: true, status: true },
      });
      if (!run) throw new NotFoundException('Delivery run not found');
      if (run.status === PrismaRunStatus.CLOSED) {
        throw new BadRequestException('Delivery run is already closed');
      }

      await this.assertProducts(
        tx,
        tenantId,
        dto.closingStock.map((stock) => stock.productId),
      );

      const totals = await this.computeTotals(tx, tenantId, id);

      await tx.deliveryRunStock.createMany({
        data: dto.closingStock.map((stock) => ({
          tenantId,
          deliveryRunId: id,
          productId: stock.productId,
          stockType: PrismaStockType.CLOSING,
          filledCount: stock.filledCount,
          emptyCount: stock.emptyCount,
        })),
      });

      await tx.deliveryRun.update({
        where: { id },
        data: {
          status: PrismaRunStatus.CLOSED,
          closingCash: dto.closingCash,
          totalSales: totals.totalSales,
          totalCashCollected: totals.totalCashCollected,
          totalExpenses: 0,
        },
      });

      return tx.deliveryRun.findFirstOrThrow({
        where: { id, tenantId },
        include: this.detailInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveryruns',
      action: 'CLOSE',
      entityId: id,
      newValue: { closingCash: dto.closingCash },
    });

    return { run: this.toDetail(closed), summary: await this.summary(id, tenantId) };
  }

  async summary(id: string, tenantId: string) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id, tenantId },
      include: {
        stocks: { include: { product: { select: { id: true, name: true } } } },
        deliveries: {
          where: { status: { not: PrismaDeliveryStatus.CANCELLED } },
          include: { items: { include: { product: { select: { id: true, name: true } } } } },
        },
      },
    });
    if (!run) throw new NotFoundException('Delivery run not found');

    const products = new Map<
      string,
      {
        productId: string;
        productName: string;
        openingFilled: number;
        openingEmpty: number;
        closingFilled: number;
        closingEmpty: number;
        delivered: number;
        emptiesReturned: number;
      }
    >();

    const ensure = (productId: string, productName: string) => {
      const existing = products.get(productId);
      if (existing) return existing;
      const created = {
        productId,
        productName,
        openingFilled: 0,
        openingEmpty: 0,
        closingFilled: 0,
        closingEmpty: 0,
        delivered: 0,
        emptiesReturned: 0,
      };
      products.set(productId, created);
      return created;
    };

    for (const stock of run.stocks) {
      const row = ensure(stock.productId, stock.product.name);
      if (stock.stockType === PrismaStockType.OPENING) {
        row.openingFilled += stock.filledCount;
        row.openingEmpty += stock.emptyCount;
      } else {
        row.closingFilled += stock.filledCount;
        row.closingEmpty += stock.emptyCount;
      }
    }

    for (const delivery of run.deliveries) {
      for (const item of delivery.items) {
        const row = ensure(item.productId, item.product.name);
        row.delivered += item.quantityDelivered;
        row.emptiesReturned += item.emptiesReceived;
      }
    }

    const productDiscrepancies = [...products.values()].map((row) => {
      const expectedClosingFilled = row.openingFilled - row.delivered;
      const expectedClosingEmpty = row.openingEmpty + row.emptiesReturned;
      const filledDifference = row.closingFilled - expectedClosingFilled;
      const emptyDifference = row.closingEmpty - expectedClosingEmpty;
      const missingContainers =
        expectedClosingFilled + expectedClosingEmpty - row.closingFilled - row.closingEmpty;
      return {
        ...row,
        expectedClosingFilled,
        expectedClosingEmpty,
        filledDifference,
        emptyDifference,
        missingContainers,
      };
    });

    const totalSales = run.deliveries.reduce(
      (sum, delivery) =>
        sum +
        delivery.items.reduce((itemSum, item) => itemSum + decimalToNumber(item.lineTotal), 0),
      0,
    );
    const totalCashCollected = run.deliveries.reduce(
      (sum, delivery) => sum + decimalToNumber(delivery.cashReceived),
      0,
    );
    const expectedCash = decimalToNumber(run.openingCash) + totalCashCollected;
    const closingCash = decimalToNumber(run.closingCash);

    return {
      runId: id,
      status: run.status as RunStatus,
      totalSales,
      totalCashCollected,
      expectedCash,
      closingCash: run.closingCash == null ? null : closingCash,
      cashDifference: run.closingCash == null ? null : closingCash - expectedCash,
      productDiscrepancies,
    };
  }

  private async computeTotals(tx: Prisma.TransactionClient, tenantId: string, runId: string) {
    const deliveries = await tx.delivery.findMany({
      where: { tenantId, deliveryRunId: runId, status: { not: PrismaDeliveryStatus.CANCELLED } },
      include: { items: true },
    });

    return {
      totalSales: deliveries.reduce(
        (sum, delivery) =>
          sum +
          delivery.items.reduce((itemSum, item) => itemSum + decimalToNumber(item.lineTotal), 0),
        0,
      ),
      totalCashCollected: deliveries.reduce(
        (sum, delivery) => sum + decimalToNumber(delivery.cashReceived),
        0,
      ),
    };
  }

  private async assertRider(tx: Prisma.TransactionClient, tenantId: string, riderId: string) {
    const rider = await tx.user.findFirst({
      where: {
        id: riderId,
        deletedAt: null,
        memberships: { some: { tenantId, status: 'ACTIVE' } },
        roles: { some: { tenantId, role: { slug: 'rider' } } },
      },
      select: { id: true },
    });
    if (!rider) throw new BadRequestException('Rider must be an active rider in this workspace');
  }

  private async assertVehicle(tx: Prisma.TransactionClient, tenantId: string, vehicleId: string) {
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, tenantId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!vehicle) throw new BadRequestException('Vehicle must be active in this workspace');
  }

  private async assertProducts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productIds: string[],
  ) {
    const ids = [...new Set(productIds)];
    const count = await tx.product.count({
      where: { tenantId, deletedAt: null, isActive: true, id: { in: ids } },
    });
    if (count !== ids.length) {
      throw new BadRequestException('One or more products are invalid for this workspace');
    }
  }

  private assertUniqueProducts(stock: DeliveryRunStockDto[]): void {
    const ids = stock.map((row) => row.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once in stock');
    }
  }

  private async assertOpeningStockNotBelowDelivered(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryRunId: string,
    openingStock: DeliveryRunStockDto[],
  ): Promise<void> {
    const productIds = openingStock.map((row) => row.productId);
    const [products, deliveries] = await Promise.all([
      tx.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: { id: true, name: true },
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
    const nameById = new Map(products.map((product) => [product.id, product.name]));
    const deliveredByProduct = new Map<string, number>();
    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        deliveredByProduct.set(
          item.productId,
          (deliveredByProduct.get(item.productId) ?? 0) + item.quantityDelivered,
        );
      }
    }

    for (const stock of openingStock) {
      const delivered = deliveredByProduct.get(stock.productId) ?? 0;
      if (stock.filledCount < delivered) {
        const name = nameById.get(stock.productId) ?? 'product';
        throw new BadRequestException(
          `Opening filled for "${name}" cannot be below already delivered qty (${delivered})`,
        );
      }
    }
  }

  private detailInclude() {
    return {
      rider: { select: { id: true, firstName: true, lastName: true, email: true } },
      vehicle: { select: { id: true, name: true, plateNumber: true, type: true } },
      stocks: { include: { product: { select: { id: true, name: true } } } },
      deliveries: {
        orderBy: { deliveryDate: 'desc' as const },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          items: { include: { product: { select: { id: true, name: true } } } },
        },
      },
    };
  }

  private toListItem(row: {
    id: string;
    tenantId: string;
    riderId: string;
    vehicleId: string;
    date: Date;
    openingCash: DecimalLike;
    status: PrismaRunStatus;
    closingCash: DecimalLike;
    totalSales: DecimalLike;
    totalCashCollected: DecimalLike;
    totalExpenses: DecimalLike;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    rider: { id: string; firstName: string; lastName: string; email: string };
    vehicle: { id: string; name: string; plateNumber: string | null };
    _count: { deliveries: number };
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      riderId: row.riderId,
      vehicleId: row.vehicleId,
      date: row.date,
      openingCash: decimalToNumber(row.openingCash),
      status: row.status as RunStatus,
      closingCash: row.closingCash == null ? null : decimalToNumber(row.closingCash),
      totalSales: decimalToNumber(row.totalSales),
      totalCashCollected: decimalToNumber(row.totalCashCollected),
      totalExpenses: decimalToNumber(row.totalExpenses),
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rider: row.rider,
      vehicle: row.vehicle,
      deliveriesCount: row._count.deliveries,
    };
  }

  private toDetail(
    row: Prisma.DeliveryRunGetPayload<{
      include: ReturnType<DeliveryRunsService['detailInclude']>;
    }>,
  ) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      riderId: row.riderId,
      vehicleId: row.vehicleId,
      date: row.date,
      openingCash: decimalToNumber(row.openingCash),
      status: row.status as RunStatus,
      closingCash: row.closingCash == null ? null : decimalToNumber(row.closingCash),
      totalSales: decimalToNumber(row.totalSales),
      totalCashCollected: decimalToNumber(row.totalCashCollected),
      totalExpenses: decimalToNumber(row.totalExpenses),
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rider: row.rider,
      vehicle: row.vehicle,
      stocks: row.stocks.map((stock) => ({
        id: stock.id,
        productId: stock.productId,
        stockType: stock.stockType as StockType,
        filledCount: stock.filledCount,
        emptyCount: stock.emptyCount,
        product: stock.product,
      })),
      deliveries: row.deliveries.map((delivery) => {
        const items = delivery.items.map((item) => ({
          id: item.id,
          productId: item.productId,
          product: item.product,
          quantityDelivered: item.quantityDelivered,
          emptiesReceived: item.emptiesReceived,
          sellingPriceSnapshot: decimalToNumber(item.sellingPriceSnapshot),
          unitCostSnapshot: decimalToNumber(item.unitCostSnapshot),
          lineTotal: decimalToNumber(item.lineTotal),
        }));
        const activeItems = items.filter(
          (item) => item.quantityDelivered > 0 || item.emptiesReceived > 0,
        );
        const totalSale = items.reduce((sum, item) => sum + item.lineTotal, 0);
        return {
          id: delivery.id,
          tenantId: delivery.tenantId,
          deliveryRunId: delivery.deliveryRunId,
          customerId: delivery.customerId,
          customer: delivery.customer,
          deliveryDate: delivery.deliveryDate,
          cashReceived: decimalToNumber(delivery.cashReceived),
          paymentMethod: delivery.paymentMethod,
          status: delivery.status,
          notes: delivery.notes,
          promisedPayDate: delivery.promisedPayDate
            ? delivery.promisedPayDate.toISOString().slice(0, 10)
            : null,
          promisedAmount:
            delivery.promisedAmount == null ? null : decimalToNumber(delivery.promisedAmount),
          totalSale,
          productsSummary: activeItems
            .map(
              (item) =>
                `${item.product.name} (${item.quantityDelivered} del / ${item.emptiesReceived} empty)`,
            )
            .join(', '),
          items,
          createdAt: delivery.createdAt,
          updatedAt: delivery.updatedAt,
        };
      }),
    };
  }
}
