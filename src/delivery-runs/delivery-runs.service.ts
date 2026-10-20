import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryStatus as PrismaDeliveryStatus,
  PlannedStopStatus as PrismaPlannedStopStatus,
  Prisma,
  RunStatus as PrismaRunStatus,
  StockMovementType,
  StockType as PrismaStockType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { RunStatus, StockType } from '../common/enums/delivery.enum';
import { parseCalendarDateUtc } from '../common/helpers/calendar-utc.helper';
import { CreateDeliveryRunDto } from './dto/create-delivery-run.dto';
import { CloseDeliveryRunDto } from './dto/close-delivery-run.dto';
import { UpdateDeliveryRunDto } from './dto/update-delivery-run.dto';
import { ListDeliveryRunsQueryDto } from './dto/list-delivery-runs-query.dto';
import { WarehouseAvailabilityQueryDto } from './dto/warehouse-availability-query.dto';
import { DeliveryRunStockDto } from './dto/delivery-run-stock.dto';
import { DeliveryRunPackagingStockDto } from './dto/delivery-run-packaging-stock.dto';
import { DeliveryRunRefillLoadDto } from './dto/delivery-run-refill-load.dto';
import { assertValidStockQuantity, decimalQtyToNumber } from '../common/helpers/product-qty.helper';
import {
  assertNoRefillLoadsWhenPlantFillDisabled,
  isPlantFillEnabled,
} from '../common/helpers/plant-fill.helper';
import {
  isReturnableContainersEnabled,
  resolveFilledPackagingCount,
} from '../common/helpers/returnable-containers.helper';
import { assertInventoryEnabled, isInventoryEnabled } from '../common/helpers/inventory.helper';
import { lockStockBalance } from '../common/helpers/stock-lock.helper';
import { applyProductStockMovement } from '../common/helpers/stock-apply.helper';
import { isRiderOnlyUser } from '../common/helpers/rider-scope.helper';
import { InventoryService } from '../inventory/inventory.service';

const DELIVERY_RUN_REF = 'DeliveryRun';
const TRUCK_LOAD_REASON = 'Truck load';
const TRUCK_RETURN_REASON = 'Leftover return';

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
export class DeliveryRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inventory: InventoryService,
  ) {}

  async create(tenantId: string, dto: CreateDeliveryRunDto, actorId: string) {
    this.assertUniqueProducts(dto.openingStock);
    if (dto.openingPackagingStock) this.assertUniquePackagingTypes(dto.openingPackagingStock);
    const date = parseDate(dto.date);
    const refillLoads = dto.refillLoads ?? [];
    const plantFillEnabled = await isPlantFillEnabled(this.prisma, tenantId);
    assertNoRefillLoadsWhenPlantFillDisabled(plantFillEnabled, refillLoads);
    const inventoryOn = await isInventoryEnabled(this.prisma, tenantId);
    const productIds = [
      ...new Set([
        ...dto.openingStock.map((stock) => stock.productId),
        ...refillLoads.map((load) => load.productId),
      ]),
    ];

    // Cheap checks outside the interactive transaction (Railway/MySQL latency).
    await Promise.all([
      this.assertRider(this.prisma, tenantId, dto.riderId),
      this.assertVehicle(this.prisma, tenantId, dto.vehicleId),
      this.assertProducts(this.prisma, tenantId, productIds),
    ]);
    const loadLocation = inventoryOn
      ? await this.resolveLoadLocation(tenantId, dto.loadLocationId)
      : null;
    // stock qty + packaging validated when resolving packaging counts below

    const runId = await this.prisma.$transaction(
      async (tx) => {
        // Re-check remaining inside the tx so concurrent loads cannot overdraw.
        const filledFromLoads = plantFillEnabled
          ? await this.resolveRefillLoads(tx, tenantId, refillLoads)
          : new Map<string, number>();
        const openingStockMerged = this.mergeOpeningStockWithRefillLoads(
          dto.openingStock,
          filledFromLoads,
        );
        const packagingMode = this.isPackagingStockMode(dto.openingPackagingStock);
        const openingPackagingStock = packagingMode
          ? await this.normalizePackagingStock(tx, tenantId, dto.openingPackagingStock ?? [])
          : [];
        const openingStock = await this.withPackagingCounts(
          tx,
          tenantId,
          openingStockMerged,
          packagingMode,
        );

        const created = await tx.deliveryRun.create({
          data: {
            tenantId,
            riderId: dto.riderId,
            vehicleId: dto.vehicleId,
            date,
            openingCash: dto.openingCash,
            notes: dto.notes?.trim() || null,
            loadLocationId: inventoryOn ? loadLocation!.id : dto.loadLocationId?.trim() || null,
            stocks: {
              create: openingStock.map((stock) => ({
                tenantId,
                productId: stock.productId,
                stockType: PrismaStockType.OPENING,
                filledCount: stock.filledCount,
                filledPackagingCount: stock.filledPackagingCount,
                emptyCount: stock.emptyCount,
              })),
            },
            ...(openingPackagingStock.length > 0
              ? {
                  packagingStocks: {
                    create: openingPackagingStock.map((stock) => ({
                      tenantId,
                      packagingTypeId: stock.packagingTypeId,
                      stockType: PrismaStockType.OPENING,
                      filledCount: stock.filledCount,
                      emptyCount: stock.emptyCount,
                    })),
                  },
                }
              : {}),
            ...(refillLoads.length > 0
              ? {
                  refillLoads: {
                    create: refillLoads.map((load) => ({
                      tenantId,
                      refillBatchId: load.refillBatchId,
                      productId: load.productId,
                      quantityLoaded: load.quantityLoaded,
                    })),
                  },
                }
              : {}),
          },
          select: { id: true },
        });

        if (inventoryOn && loadLocation) {
          await this.postTruckLoadWarehouseOut(tx, {
            tenantId,
            locationId: loadLocation.id,
            runId: created.id,
            actorId,
            lines: openingStock.map((stock) => ({
              productId: stock.productId,
              qty: stock.filledCount,
            })),
          });
        }

        return created.id;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    const run = await this.prisma.deliveryRun.findFirstOrThrow({
      where: { id: runId, tenantId },
      include: this.detailInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'deliveryruns',
      action: 'CREATE',
      entityId: run.id,
      newValue: {
        riderId: run.riderId,
        vehicleId: run.vehicleId,
        date: run.date,
        loadLocationId: run.loadLocationId,
        warehouseTransferOut: inventoryOn,
        refillLoads: refillLoads.map((load) => ({
          refillBatchId: load.refillBatchId,
          productId: load.productId,
          quantityLoaded: load.quantityLoaded,
        })),
      },
    });

    return this.toDetail(run);
  }

  /**
   * Available warehouse qty per product for truck load UI (inventory ON only).
   * excludeRunId adds back that run’s prior TRANSFER_OUT (edit-opening case).
   */
  async warehouseAvailability(tenantId: string, query: WarehouseAvailabilityQueryDto) {
    await assertInventoryEnabled(this.prisma, tenantId);
    const location = await this.resolveLoadLocation(tenantId, query.locationId);

    const balances = await this.prisma.stockBalance.findMany({
      where: { tenantId, locationId: location.id },
      select: { productId: true, quantity: true },
    });
    const available = new Map<string, number>(
      balances.map((row) => [row.productId, decimalToNumber(row.quantity)]),
    );

    const excludeRunId = query.excludeRunId?.trim();
    if (excludeRunId) {
      const run = await this.prisma.deliveryRun.findFirst({
        where: { id: excludeRunId, tenantId },
        select: { id: true },
      });
      if (!run) throw new NotFoundException('Delivery run not found');

      const outs = await this.prisma.stockMovement.findMany({
        where: {
          tenantId,
          locationId: location.id,
          referenceType: DELIVERY_RUN_REF,
          referenceId: excludeRunId,
          type: StockMovementType.TRANSFER_OUT,
        },
        select: { productId: true, quantity: true },
      });
      for (const m of outs) {
        const addBack = Math.abs(decimalToNumber(m.quantity));
        available.set(m.productId, (available.get(m.productId) ?? 0) + addBack);
      }
    }

    return {
      locationId: location.id,
      locationName: location.name,
      items: [...available.entries()].map(([productId, availableQty]) => ({
        productId,
        availableQty,
      })),
    };
  }

  async list(
    tenantId: string,
    query: ListDeliveryRunsQueryDto,
    actorId: string,
  ): Promise<PaginatedData<ReturnType<DeliveryRunsService['toListItem']>>> {
    const { skip, take } = getPaginationParams(query);
    const where: Prisma.DeliveryRunWhereInput = { tenantId };

    const riderOnly = await isRiderOnlyUser(this.prisma, tenantId, actorId);
    // Pure riders always see only their runs (ignore client riderId to prevent bypass).
    if (riderOnly) {
      where.riderId = actorId;
    } else if (query.riderId) {
      where.riderId = query.riderId;
    }
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

  async findOne(id: string, tenantId: string, actorId: string) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id, tenantId },
      include: this.detailInclude(),
    });
    if (!run) throw new NotFoundException('Delivery run not found');
    await this.assertRiderOwnsRun(tenantId, actorId, run.riderId);
    return this.toDetail(run);
  }

  async update(id: string, tenantId: string, dto: UpdateDeliveryRunDto, actorId: string) {
    if (
      dto.openingCash == null &&
      !dto.openingStock &&
      dto.openingPackagingStock === undefined &&
      dto.notes === undefined &&
      dto.loadLocationId === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }
    if (dto.openingStock) this.assertUniqueProducts(dto.openingStock);
    if (dto.openingPackagingStock) this.assertUniquePackagingTypes(dto.openingPackagingStock);

    await this.assertRiderCanAccessRunId(tenantId, id, actorId);

    const inventoryOn = await isInventoryEnabled(this.prisma, tenantId);
    const warehouseAffecting =
      !!dto.openingStock ||
      dto.openingPackagingStock !== undefined ||
      dto.loadLocationId !== undefined;
    const resolvedLocation =
      inventoryOn && warehouseAffecting
        ? await this.resolveLoadLocation(
            tenantId,
            dto.loadLocationId !== undefined
              ? dto.loadLocationId
              : (
                  await this.prisma.deliveryRun.findFirst({
                    where: { id, tenantId },
                    select: { loadLocationId: true },
                  })
                )?.loadLocationId,
          )
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findFirst({
        where: { id, tenantId },
        select: { id: true, status: true, loadLocationId: true },
      });
      if (!run) throw new NotFoundException('Delivery run not found');
      if (run.status !== PrismaRunStatus.OPEN) {
        throw new BadRequestException('Only open delivery runs can be edited');
      }

      if (inventoryOn && warehouseAffecting) {
        const deliveriesCount = await tx.delivery.count({
          where: {
            tenantId,
            deliveryRunId: id,
            status: { not: PrismaDeliveryStatus.CANCELLED },
          },
        });
        if (deliveriesCount > 0) {
          throw new BadRequestException(
            'Cannot change opening stock or load location after deliveries when inventory is enabled',
          );
        }
      }

      let openingStockForWarehouse: Array<{ productId: string; filledCount: number }> | null = null;

      if (dto.openingStock || dto.openingPackagingStock !== undefined) {
        const packagingMode =
          dto.openingPackagingStock !== undefined
            ? this.isPackagingStockMode(dto.openingPackagingStock)
            : await this.runHasPackagingStock(tx, tenantId, id);

        if (dto.openingStock) {
          await this.assertProducts(
            tx,
            tenantId,
            dto.openingStock.map((stock) => stock.productId),
          );
          const openingStock = await this.withPackagingCounts(
            tx,
            tenantId,
            dto.openingStock,
            packagingMode,
          );
          await this.assertOpeningStockNotBelowDelivered(
            tx,
            tenantId,
            id,
            openingStock,
            packagingMode,
          );
          openingStockForWarehouse = openingStock.map((stock) => ({
            productId: stock.productId,
            filledCount: stock.filledCount,
          }));

          for (const stock of openingStock) {
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
                filledPackagingCount: stock.filledPackagingCount,
                emptyCount: stock.emptyCount,
              },
              update: {
                filledCount: stock.filledCount,
                filledPackagingCount: stock.filledPackagingCount,
                emptyCount: stock.emptyCount,
              },
            });
          }
        }

        if (dto.openingPackagingStock !== undefined) {
          const packagingRows = packagingMode
            ? await this.normalizePackagingStock(tx, tenantId, dto.openingPackagingStock)
            : [];
          if (packagingMode) {
            await this.assertOpeningPackagingNotBelowDelivered(tx, tenantId, id, packagingRows);
          }
          await tx.deliveryRunPackagingStock.deleteMany({
            where: {
              tenantId,
              deliveryRunId: id,
              stockType: PrismaStockType.OPENING,
            },
          });
          if (packagingRows.length > 0) {
            await tx.deliveryRunPackagingStock.createMany({
              data: packagingRows.map((stock) => ({
                tenantId,
                deliveryRunId: id,
                packagingTypeId: stock.packagingTypeId,
                stockType: PrismaStockType.OPENING,
                filledCount: stock.filledCount,
                emptyCount: stock.emptyCount,
              })),
            });
          }
        }
      }

      if (inventoryOn && warehouseAffecting && resolvedLocation) {
        await this.reverseTruckLoadWarehouseOut(tx, tenantId, id);

        if (!openingStockForWarehouse) {
          const existing = await tx.deliveryRunStock.findMany({
            where: {
              tenantId,
              deliveryRunId: id,
              stockType: PrismaStockType.OPENING,
            },
            select: { productId: true, filledCount: true },
          });
          openingStockForWarehouse = existing.map((row) => ({
            productId: row.productId,
            filledCount: decimalQtyToNumber(row.filledCount),
          }));
        }

        await this.postTruckLoadWarehouseOut(tx, {
          tenantId,
          locationId: resolvedLocation.id,
          runId: id,
          actorId,
          lines: openingStockForWarehouse.map((stock) => ({
            productId: stock.productId,
            qty: stock.filledCount,
          })),
        });
      }

      await tx.deliveryRun.update({
        where: { id },
        data: {
          ...(dto.openingCash != null ? { openingCash: dto.openingCash } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(inventoryOn && warehouseAffecting && resolvedLocation
            ? { loadLocationId: resolvedLocation.id }
            : dto.loadLocationId !== undefined && !inventoryOn
              ? { loadLocationId: dto.loadLocationId?.trim() || null }
              : {}),
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
        loadLocationId: updated.loadLocationId,
        warehouseTransferOut: inventoryOn && warehouseAffecting,
      },
    });

    return this.toDetail(updated);
  }

  async close(id: string, tenantId: string, dto: CloseDeliveryRunDto, actorId: string) {
    await this.assertRiderCanAccessRunId(tenantId, id, actorId);
    this.assertUniqueProducts(dto.closingStock);
    if (dto.closingPackagingStock) this.assertUniquePackagingTypes(dto.closingPackagingStock);
    const returnLines = (dto.returnToWarehouse ?? []).filter((line) => line.qty > 0);
    if (returnLines.length > 0) {
      this.assertUniqueReturnProducts(returnLines);
      await assertInventoryEnabled(this.prisma, tenantId);
    }
    const inventoryOn = await isInventoryEnabled(this.prisma, tenantId);
    const returnLocation =
      returnLines.length > 0
        ? await this.resolveLoadLocation(
            tenantId,
            (
              await this.prisma.deliveryRun.findFirst({
                where: { id, tenantId },
                select: { loadLocationId: true },
              })
            )?.loadLocationId,
          )
        : null;

    const closed = await this.prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findFirst({
        where: { id, tenantId },
        select: { id: true, status: true, loadLocationId: true },
      });
      if (!run) throw new NotFoundException('Delivery run not found');
      if (run.status === PrismaRunStatus.CLOSED) {
        throw new BadRequestException('Delivery run is already closed');
      }

      const productIds = [
        ...new Set([
          ...dto.closingStock.map((stock) => stock.productId),
          ...returnLines.map((line) => line.productId),
        ]),
      ];
      await this.assertProducts(tx, tenantId, productIds);
      const packagingMode = await this.runHasPackagingStock(tx, tenantId, id);
      if (packagingMode && (!dto.closingPackagingStock || dto.closingPackagingStock.length === 0)) {
        throw new BadRequestException(
          'Closing packaging stock is required when this run loaded cans by packaging type',
        );
      }
      const closingPackagingStock = packagingMode
        ? await this.normalizePackagingStock(tx, tenantId, dto.closingPackagingStock ?? [])
        : [];
      const closingStock = await this.withPackagingCounts(
        tx,
        tenantId,
        dto.closingStock,
        packagingMode,
      );

      const leftovers = await this.computeLeftoverFilled(tx, tenantId, id);
      const returnByProduct = new Map(returnLines.map((line) => [line.productId, line.qty]));

      if (returnLines.length > 0) {
        const products = await tx.product.findMany({
          where: { tenantId, id: { in: returnLines.map((l) => l.productId) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(products.map((p) => [p.id, p.name]));

        for (const line of returnLines) {
          const leftover = leftovers.get(line.productId) ?? 0;
          const name = nameById.get(line.productId) ?? 'product';
          if (line.qty > leftover + 1e-9) {
            throw new BadRequestException(
              `Cannot return ${line.qty} of "${name}" — only ${leftover} leftover on truck`,
            );
          }
        }

        // Closing filled + return must not exceed leftover (avoid double-count).
        for (const stock of closingStock) {
          const returned = returnByProduct.get(stock.productId) ?? 0;
          if (!(returned > 0)) continue;
          const leftover = leftovers.get(stock.productId) ?? 0;
          const maxClosing = leftover - returned;
          if (stock.filledCount > maxClosing + 1e-9) {
            const name = nameById.get(stock.productId) ?? 'product';
            throw new BadRequestException(
              `Closing filled plus return for "${name}" exceeds leftover (${leftover}). Max closing after return: ${Math.max(0, maxClosing)}`,
            );
          }
        }

        await this.postTruckReturnWarehouseIn(tx, {
          tenantId,
          locationId: returnLocation!.id,
          runId: id,
          actorId,
          lines: returnLines.map((line) => ({
            productId: line.productId,
            qty: line.qty,
          })),
        });
      }

      const totals = await this.computeTotals(tx, tenantId, id);

      await tx.deliveryRunStock.createMany({
        data: closingStock.map((stock) => ({
          tenantId,
          deliveryRunId: id,
          productId: stock.productId,
          stockType: PrismaStockType.CLOSING,
          filledCount: stock.filledCount,
          filledPackagingCount: stock.filledPackagingCount,
          emptyCount: stock.emptyCount,
        })),
      });

      if (closingPackagingStock.length > 0) {
        await tx.deliveryRunPackagingStock.createMany({
          data: closingPackagingStock.map((stock) => ({
            tenantId,
            deliveryRunId: id,
            packagingTypeId: stock.packagingTypeId,
            stockType: PrismaStockType.CLOSING,
            filledCount: stock.filledCount,
            emptyCount: stock.emptyCount,
          })),
        });
      }

      await tx.deliveryRun.update({
        where: { id },
        data: {
          status: PrismaRunStatus.CLOSED,
          closingCash: dto.closingCash,
          totalSales: totals.totalSales,
          totalCashCollected: totals.totalCashCollected,
          totalExpenses: 0,
          ...(inventoryOn && returnLocation && !run.loadLocationId
            ? { loadLocationId: returnLocation.id }
            : {}),
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
      newValue: {
        closingCash: dto.closingCash,
        returnToWarehouse: returnLines,
        warehouseTransferIn: returnLines.length > 0,
      },
    });

    return { run: this.toDetail(closed), summary: await this.summary(id, tenantId, actorId) };
  }

  async summary(id: string, tenantId: string, actorId: string) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id, tenantId },
      include: {
        stocks: { include: { product: { select: { id: true, name: true } } } },
        packagingStocks: {
          include: { packagingType: { select: { id: true, name: true } } },
        },
        deliveries: {
          where: { status: { not: PrismaDeliveryStatus.CANCELLED } },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    packagingTypeId: true,
                    packagingType: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Delivery run not found');
    await this.assertRiderOwnsRun(tenantId, actorId, run.riderId);

    const products = new Map<
      string,
      {
        productId: string;
        productName: string;
        openingFilled: number;
        openingPackaging: number;
        openingEmpty: number;
        closingFilled: number;
        closingPackaging: number;
        closingEmpty: number;
        delivered: number;
        containersDelivered: number;
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
        openingPackaging: 0,
        openingEmpty: 0,
        closingFilled: 0,
        closingPackaging: 0,
        closingEmpty: 0,
        delivered: 0,
        containersDelivered: 0,
        emptiesReturned: 0,
      };
      products.set(productId, created);
      return created;
    };

    for (const stock of run.stocks) {
      const row = ensure(stock.productId, stock.product.name);
      if (stock.stockType === PrismaStockType.OPENING) {
        row.openingFilled += decimalQtyToNumber(stock.filledCount);
        row.openingPackaging += stock.filledPackagingCount;
        row.openingEmpty += stock.emptyCount;
      } else {
        row.closingFilled += decimalQtyToNumber(stock.filledCount);
        row.closingPackaging += stock.filledPackagingCount;
        row.closingEmpty += stock.emptyCount;
      }
    }

    for (const delivery of run.deliveries) {
      for (const item of delivery.items) {
        const row = ensure(item.productId, item.product.name);
        row.delivered += decimalQtyToNumber(item.quantityDelivered);
        row.containersDelivered += item.containersDelivered;
        row.emptiesReturned += item.emptiesReceived;
      }
    }

    const productDiscrepancies = [...products.values()].map((row) => {
      const expectedClosingFilled = row.openingFilled - row.delivered;
      const expectedClosingEmpty = row.openingEmpty + row.emptiesReturned;
      const expectedClosingPackaging = row.openingPackaging - row.containersDelivered;
      const filledDifference = row.closingFilled - expectedClosingFilled;
      const emptyDifference = row.closingEmpty - expectedClosingEmpty;
      const missingContainers =
        expectedClosingPackaging + expectedClosingEmpty - row.closingPackaging - row.closingEmpty;
      return {
        productId: row.productId,
        productName: row.productName,
        openingFilled: row.openingFilled,
        openingEmpty: row.openingEmpty,
        closingFilled: row.closingFilled,
        closingEmpty: row.closingEmpty,
        delivered: row.delivered,
        emptiesReturned: row.emptiesReturned,
        expectedClosingFilled,
        expectedClosingEmpty,
        filledDifference,
        emptyDifference,
        missingContainers,
      };
    });

    const packaging = new Map<
      string,
      {
        packagingTypeId: string;
        name: string;
        openingFilled: number;
        openingEmpty: number;
        closingFilled: number;
        closingEmpty: number;
        containersDelivered: number;
        emptiesReturned: number;
      }
    >();
    const ensurePkg = (packagingTypeId: string, name: string) => {
      const existing = packaging.get(packagingTypeId);
      if (existing) return existing;
      const created = {
        packagingTypeId,
        name,
        openingFilled: 0,
        openingEmpty: 0,
        closingFilled: 0,
        closingEmpty: 0,
        containersDelivered: 0,
        emptiesReturned: 0,
      };
      packaging.set(packagingTypeId, created);
      return created;
    };

    for (const stock of run.packagingStocks) {
      const row = ensurePkg(stock.packagingTypeId, stock.packagingType.name);
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
        const typeId = item.product.packagingTypeId;
        if (!typeId) continue;
        const typeName = item.product.packagingType?.name ?? item.product.name;
        const row = ensurePkg(typeId, typeName);
        row.containersDelivered += item.containersDelivered;
        row.emptiesReturned += item.emptiesReceived;
      }
    }

    const packagingDiscrepancies = [...packaging.values()].map((row) => {
      const expectedClosingFilled = row.openingFilled - row.containersDelivered;
      const expectedClosingEmpty = row.openingEmpty + row.emptiesReturned;
      return {
        packagingTypeId: row.packagingTypeId,
        name: row.name,
        openingFilled: row.openingFilled,
        openingEmpty: row.openingEmpty,
        closingFilled: row.closingFilled,
        closingEmpty: row.closingEmpty,
        containersDelivered: row.containersDelivered,
        emptiesReturned: row.emptiesReturned,
        expectedClosingFilled,
        expectedClosingEmpty,
        filledDifference: row.closingFilled - expectedClosingFilled,
        emptyDifference: row.closingEmpty - expectedClosingEmpty,
        missingContainers:
          expectedClosingFilled + expectedClosingEmpty - row.closingFilled - row.closingEmpty,
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
      packagingDiscrepancies,
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

  private async assertRider(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    riderId: string,
  ) {
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

  /** Pure riders may only touch runs where they are the assigned rider. */
  private async assertRiderOwnsRun(tenantId: string, actorId: string, runRiderId: string) {
    const riderOnly = await isRiderOnlyUser(this.prisma, tenantId, actorId);
    if (!riderOnly) return;
    if (runRiderId !== actorId) {
      throw new NotFoundException('Delivery run not found');
    }
  }

  private async assertRiderCanAccessRunId(tenantId: string, runId: string, actorId: string) {
    const riderOnly = await isRiderOnlyUser(this.prisma, tenantId, actorId);
    if (!riderOnly) return;
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id: runId, tenantId },
      select: { riderId: true },
    });
    if (!run || run.riderId !== actorId) {
      throw new NotFoundException('Delivery run not found');
    }
  }

  private async assertVehicle(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    vehicleId: string,
  ) {
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, tenantId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!vehicle) throw new BadRequestException('Vehicle must be active in this workspace');
  }

  private async assertProducts(
    tx: Prisma.TransactionClient | PrismaService,
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

  private async resolveLoadLocation(tenantId: string, loadLocationId?: string | null) {
    const defaultLoc = await this.inventory.ensureDefaultLocation(tenantId);
    const requested = loadLocationId?.trim();
    if (!requested) return defaultLoc;

    const loc = await this.prisma.stockLocation.findFirst({
      where: { id: requested, tenantId, isActive: true },
      select: { id: true, name: true, isDefault: true, type: true, isActive: true },
    });
    if (!loc) throw new NotFoundException('Stock location not found');
    return loc;
  }

  /**
   * Remove prior truck-load TRANSFER_OUT for this run and restore warehouse balances.
   * Safe before first delivery (inventory ON edit path). Never SALE_OUT.
   */
  private async reverseTruckLoadWarehouseOut(
    tx: Prisma.TransactionClient,
    tenantId: string,
    runId: string,
  ) {
    const outs = await tx.stockMovement.findMany({
      where: {
        tenantId,
        referenceType: DELIVERY_RUN_REF,
        referenceId: runId,
        type: StockMovementType.TRANSFER_OUT,
      },
    });

    for (const m of outs) {
      const restore = new Prisma.Decimal(m.quantity).neg();
      await this.applyWarehouseBalanceDelta(tx, {
        tenantId,
        locationId: m.locationId,
        productId: m.productId,
        delta: restore,
        allowNegative: false,
        productName: null,
      });
      await tx.stockMovement.delete({ where: { id: m.id } });
    }
  }

  /** Post warehouse TRANSFER_OUT for opening filled qty (caps ≤ StockBalance). */
  private async postTruckLoadWarehouseOut(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      runId: string;
      actorId: string;
      lines: Array<{ productId: string; qty: number }>;
    },
  ) {
    const productIds = [...new Set(args.lines.filter((l) => l.qty > 0).map((l) => l.productId))];
    const products =
      productIds.length === 0
        ? []
        : await tx.product.findMany({
            where: { tenantId: args.tenantId, id: { in: productIds } },
            select: { id: true, name: true },
          });
    const nameById = new Map(products.map((p) => [p.id, p.name]));

    for (const line of args.lines) {
      if (!(line.qty > 0)) continue;
      const qty = new Prisma.Decimal(line.qty);
      const name = nameById.get(line.productId) ?? 'product';
      await applyProductStockMovement(tx, {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: line.productId,
        type: StockMovementType.TRANSFER_OUT,
        quantity: qty.neg(),
        reason: TRUCK_LOAD_REASON,
        referenceType: DELIVERY_RUN_REF,
        referenceId: args.runId,
        actorId: args.actorId,
        insufficientMessage: `Cannot load ${line.qty} of "${name}" — only available qty at warehouse is too low`,
      });
    }
  }

  private async applyWarehouseBalanceDelta(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      productId: string;
      delta: Prisma.Decimal;
      allowNegative: boolean;
      productName: string | null;
      loadQty?: number;
    },
  ) {
    const balance = await lockStockBalance(tx, {
      tenantId: args.tenantId,
      locationId: args.locationId,
      productId: args.productId,
    });
    const current = new Prisma.Decimal(balance.quantity);
    const next = current.add(args.delta);

    if (!args.allowNegative && next.lessThan(0)) {
      const available = decimalToNumber(current);
      const name = args.productName ?? 'product';
      const loadQty = args.loadQty ?? Math.abs(decimalToNumber(args.delta));
      throw new BadRequestException(
        `Cannot load ${loadQty} of "${name}" — only ${available} available at warehouse`,
      );
    }

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { quantity: next },
    });
  }

  /**
   * Validate base qty + empties, resolve filledPackagingCount (explicit for LTR/KG returnable).
   * When packagingMode: product can fields are zeroed — truck cans live on DeliveryRunPackagingStock.
   */
  private async withPackagingCounts(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    stock: DeliveryRunStockDto[],
    packagingMode = false,
  ): Promise<Array<DeliveryRunStockDto & { filledPackagingCount: number }>> {
    if (stock.length === 0) return [];

    const containersEnabled = await isReturnableContainersEnabled(tx, tenantId);
    const products = await tx.product.findMany({
      where: {
        tenantId,
        id: { in: stock.map((s) => s.productId) },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        allowFractionalQty: true,
        baseUnit: true,
        isReturnable: true,
        containerCapacity: true,
        packagingTypeId: true,
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return stock.map((row) => {
      const product = byId.get(row.productId);
      if (!product) {
        throw new BadRequestException('One or more products are invalid for this workspace');
      }
      assertValidStockQuantity(row.filledCount, product, 'units loaded');

      const trackContainers = containersEnabled && product.isReturnable;
      if (packagingMode && trackContainers) {
        return {
          ...row,
          emptyCount: 0,
          filledPackagingCount: 0,
        };
      }

      if (!Number.isInteger(row.emptyCount)) {
        throw new BadRequestException(`Empty count for "${product.name}" must be a whole number`);
      }

      const filledPackagingCount = trackContainers
        ? resolveFilledPackagingCount(product, row.filledCount, row.filledPackagingCount)
        : 0;

      return {
        ...row,
        emptyCount: trackContainers ? row.emptyCount : 0,
        filledPackagingCount,
      };
    });
  }

  private isPackagingStockMode(rows: DeliveryRunPackagingStockDto[] | undefined): boolean {
    if (!rows || rows.length === 0) return false;
    return rows.some((row) => row.filledCount > 0 || row.emptyCount > 0);
  }

  private async runHasPackagingStock(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    deliveryRunId: string,
  ): Promise<boolean> {
    const count = await tx.deliveryRunPackagingStock.count({
      where: {
        tenantId,
        deliveryRunId,
        stockType: PrismaStockType.OPENING,
      },
    });
    return count > 0;
  }

  private async normalizePackagingStock(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    rows: DeliveryRunPackagingStockDto[],
  ): Promise<DeliveryRunPackagingStockDto[]> {
    if (!(await isReturnableContainersEnabled(tx, tenantId))) {
      throw new BadRequestException('Returnable containers are disabled for this workspace');
    }
    const active = rows.filter((row) => row.filledCount > 0 || row.emptyCount > 0);
    if (active.length === 0) return [];

    this.assertUniquePackagingTypes(active);
    const ids = active.map((row) => row.packagingTypeId);
    const types = await tx.packagingType.findMany({
      where: { tenantId, deletedAt: null, isActive: true, id: { in: ids } },
      select: { id: true },
    });
    if (types.length !== ids.length) {
      throw new BadRequestException('All packaging types must be active in this workspace');
    }
    return active;
  }

  private assertUniquePackagingTypes(stock: DeliveryRunPackagingStockDto[]): void {
    const ids = stock.map((row) => row.packagingTypeId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each packaging type can appear only once in stock');
    }
  }

  private assertUniqueProducts(stock: DeliveryRunStockDto[]): void {
    const ids = stock.map((row) => row.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once in stock');
    }
  }

  private assertUniqueReturnProducts(lines: Array<{ productId: string }>): void {
    const ids = lines.map((row) => row.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once in returnToWarehouse');
    }
  }

  /** Leftover filled on truck = opening filled − delivered (non-cancelled). */
  private async computeLeftoverFilled(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryRunId: string,
  ): Promise<Map<string, number>> {
    const [openingStocks, deliveries] = await Promise.all([
      tx.deliveryRunStock.findMany({
        where: {
          tenantId,
          deliveryRunId,
          stockType: PrismaStockType.OPENING,
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
            select: { productId: true, quantityDelivered: true },
          },
        },
      }),
    ]);

    const leftover = new Map<string, number>();
    for (const stock of openingStocks) {
      leftover.set(stock.productId, decimalQtyToNumber(stock.filledCount));
    }
    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        const current = leftover.get(item.productId) ?? 0;
        leftover.set(item.productId, current - decimalQtyToNumber(item.quantityDelivered));
      }
    }
    for (const [productId, qty] of leftover) {
      leftover.set(productId, Math.max(0, qty));
    }
    return leftover;
  }

  /** Post warehouse TRANSFER_IN for leftover return (inventory ON close path). */
  private async postTruckReturnWarehouseIn(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      runId: string;
      actorId: string;
      lines: Array<{ productId: string; qty: number }>;
    },
  ) {
    for (const line of args.lines) {
      if (!(line.qty > 0)) continue;
      const qty = new Prisma.Decimal(line.qty);
      await applyProductStockMovement(tx, {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: line.productId,
        type: StockMovementType.TRANSFER_IN,
        quantity: qty,
        reason: TRUCK_RETURN_REASON,
        referenceType: DELIVERY_RUN_REF,
        referenceId: args.runId,
        actorId: args.actorId,
      });
    }
  }

  /**
   * Validate refill loads against batch remaining qty and return filledCount overrides by productId.
   */
  private async resolveRefillLoads(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loads: DeliveryRunRefillLoadDto[],
  ): Promise<Map<string, number>> {
    const filledByProduct = new Map<string, number>();
    if (loads.length === 0) return filledByProduct;

    const batchIds = loads.map((load) => load.refillBatchId);
    if (new Set(batchIds).size !== batchIds.length) {
      throw new BadRequestException('Each refill batch can be loaded only once on a run');
    }

    const batches = await tx.refillBatch.findMany({
      where: { tenantId, id: { in: batchIds } },
      include: { loads: { select: { quantityLoaded: true } } },
    });
    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));

    for (const load of loads) {
      const batch = batchMap.get(load.refillBatchId);
      if (!batch) {
        throw new BadRequestException(`Refill batch ${load.refillBatchId} not found`);
      }
      if (batch.productId !== load.productId) {
        throw new BadRequestException(
          `Refill batch product mismatch for batch ${load.refillBatchId}`,
        );
      }

      const alreadyLoaded = batch.loads.reduce((sum, row) => sum + row.quantityLoaded, 0);
      const remaining = batch.cansFilledCount - alreadyLoaded;
      if (load.quantityLoaded > remaining) {
        throw new BadRequestException(
          `Cannot load ${load.quantityLoaded} from batch ${load.refillBatchId}; only ${remaining} remaining`,
        );
      }

      filledByProduct.set(
        load.productId,
        (filledByProduct.get(load.productId) ?? 0) + load.quantityLoaded,
      );
    }

    return filledByProduct;
  }

  /**
   * When refillLoads are present for a product, opening filledCount = SUM(quantityLoaded).
   * emptyCount always comes from client openingStock (or 0 if product only appears in loads).
   */
  private mergeOpeningStockWithRefillLoads(
    openingStock: DeliveryRunStockDto[],
    filledFromLoads: Map<string, number>,
  ): DeliveryRunStockDto[] {
    const byProduct = new Map(openingStock.map((stock) => [stock.productId, { ...stock }]));

    for (const [productId, filledCount] of filledFromLoads) {
      const existing = byProduct.get(productId);
      if (existing) {
        existing.filledCount = filledCount;
      } else {
        byProduct.set(productId, { productId, filledCount, emptyCount: 0 });
      }
    }

    return [...byProduct.values()];
  }

  private async assertOpeningStockNotBelowDelivered(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryRunId: string,
    openingStock: Array<DeliveryRunStockDto & { filledPackagingCount: number }>,
    packagingMode = false,
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
            select: {
              productId: true,
              quantityDelivered: true,
              containersDelivered: true,
            },
          },
        },
      }),
    ]);
    const nameById = new Map(products.map((product) => [product.id, product.name]));
    const deliveredByProduct = new Map<string, number>();
    const cansDeliveredByProduct = new Map<string, number>();
    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        deliveredByProduct.set(
          item.productId,
          (deliveredByProduct.get(item.productId) ?? 0) +
            decimalQtyToNumber(item.quantityDelivered),
        );
        cansDeliveredByProduct.set(
          item.productId,
          (cansDeliveredByProduct.get(item.productId) ?? 0) + item.containersDelivered,
        );
      }
    }

    for (const stock of openingStock) {
      const name = nameById.get(stock.productId) ?? 'product';
      const delivered = deliveredByProduct.get(stock.productId) ?? 0;
      if (stock.filledCount + 1e-9 < delivered) {
        throw new BadRequestException(
          `Opening filled for "${name}" cannot be below already delivered qty (${delivered})`,
        );
      }
      if (packagingMode) continue;
      const cansDelivered = cansDeliveredByProduct.get(stock.productId) ?? 0;
      if (stock.filledPackagingCount < cansDelivered) {
        throw new BadRequestException(
          `Opening cans for "${name}" cannot be below already delivered cans (${cansDelivered})`,
        );
      }
    }
  }

  private async assertOpeningPackagingNotBelowDelivered(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryRunId: string,
    packagingStock: DeliveryRunPackagingStockDto[],
  ): Promise<void> {
    const deliveries = await tx.delivery.findMany({
      where: {
        tenantId,
        deliveryRunId,
        status: { not: PrismaDeliveryStatus.CANCELLED },
      },
      select: {
        items: {
          select: {
            containersDelivered: true,
            product: {
              select: {
                packagingTypeId: true,
                packagingType: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    const cansByType = new Map<string, number>();
    const nameByType = new Map<string, string>();
    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        const typeId = item.product.packagingTypeId;
        if (!typeId || item.containersDelivered <= 0) continue;
        cansByType.set(typeId, (cansByType.get(typeId) ?? 0) + item.containersDelivered);
        if (item.product.packagingType?.name) {
          nameByType.set(typeId, item.product.packagingType.name);
        }
      }
    }
    if (cansByType.size === 0) return;

    const filledByType = new Map(
      packagingStock.map((row) => [row.packagingTypeId, row.filledCount]),
    );
    for (const [typeId, delivered] of cansByType) {
      const filled = filledByType.get(typeId) ?? 0;
      if (filled < delivered) {
        const name = nameByType.get(typeId) ?? 'packaging';
        throw new BadRequestException(
          `Opening cans for "${name}" cannot be below already delivered cans (${delivered})`,
        );
      }
    }
  }

  private detailInclude() {
    return {
      rider: { select: { id: true, firstName: true, lastName: true, email: true } },
      vehicle: { select: { id: true, name: true, plateNumber: true, type: true } },
      loadLocation: { select: { id: true, name: true, isDefault: true } },
      stocks: { include: { product: { select: { id: true, name: true } } } },
      packagingStocks: {
        include: {
          packagingType: { select: { id: true, name: true, capacity: true } },
        },
      },
      refillLoads: {
        include: {
          product: { select: { id: true, name: true } },
          refillBatch: {
            select: {
              id: true,
              date: true,
              cansFilledCount: true,
              costPerUnit: true,
            },
          },
        },
      },
      deliveries: {
        orderBy: { deliveryDate: 'desc' as const },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          items: { include: { product: { select: { id: true, name: true } } } },
        },
      },
      plannedStops: {
        where: {
          status: {
            in: [PrismaPlannedStopStatus.INCLUDED, PrismaPlannedStopStatus.COMPLETED],
          },
        },
        orderBy: [{ status: 'asc' as const }, { planDate: 'asc' as const }],
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              areaId: true,
              area: { select: { name: true } },
            },
          },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  baseUnit: true,
                  allowFractionalQty: true,
                },
              },
            },
          },
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
      loadLocationId: row.loadLocationId,
      loadLocation: row.loadLocation,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rider: row.rider,
      vehicle: row.vehicle,
      stocks: row.stocks.map((stock) => ({
        id: stock.id,
        productId: stock.productId,
        stockType: stock.stockType as StockType,
        filledCount: decimalQtyToNumber(stock.filledCount),
        filledPackagingCount: stock.filledPackagingCount,
        emptyCount: stock.emptyCount,
        product: stock.product,
      })),
      packagingStocks: row.packagingStocks.map((stock) => ({
        id: stock.id,
        packagingTypeId: stock.packagingTypeId,
        stockType: stock.stockType as StockType,
        filledCount: stock.filledCount,
        emptyCount: stock.emptyCount,
        packagingType: {
          id: stock.packagingType.id,
          name: stock.packagingType.name,
          capacity:
            stock.packagingType.capacity == null
              ? null
              : Number(stock.packagingType.capacity.toString()),
        },
      })),
      refillLoads: row.refillLoads.map((load) => ({
        id: load.id,
        refillBatchId: load.refillBatchId,
        productId: load.productId,
        quantityLoaded: load.quantityLoaded,
        product: load.product,
        refillBatch: {
          id: load.refillBatch.id,
          date: load.refillBatch.date,
          cansFilledCount: load.refillBatch.cansFilledCount,
          costPerUnit: decimalToNumber(load.refillBatch.costPerUnit),
        },
      })),
      deliveries: row.deliveries.map((delivery) => {
        const items = delivery.items.map((item) => ({
          id: item.id,
          productId: item.productId,
          product: item.product,
          quantityDelivered: decimalQtyToNumber(item.quantityDelivered),
          containersDelivered: item.containersDelivered,
          emptiesReceived: item.emptiesReceived,
          sellingPriceSnapshot: decimalToNumber(item.sellingPriceSnapshot),
          unitCostSnapshot: decimalToNumber(item.unitCostSnapshot),
          lineTotal: decimalToNumber(item.lineTotal),
        }));
        const activeItems = items.filter(
          (item) =>
            item.quantityDelivered > 0 || item.containersDelivered > 0 || item.emptiesReceived > 0,
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
            .map((item) => {
              const cans =
                item.containersDelivered > 0 ? ` / ${item.containersDelivered} cans` : '';
              return `${item.product.name} (${item.quantityDelivered} del${cans} / ${item.emptiesReceived} empty)`;
            })
            .join(', '),
          items,
          createdAt: delivery.createdAt,
          updatedAt: delivery.updatedAt,
        };
      }),
      plannedStops: row.plannedStops.map((stop) => ({
        id: stop.id,
        planDate: stop.planDate.toISOString().slice(0, 10),
        customerId: stop.customerId,
        customerName: stop.customer.name,
        customerPhone: stop.customer.phone,
        areaId: stop.customer.areaId,
        areaName: stop.customer.area?.name ?? null,
        deliveryRunId: stop.deliveryRunId,
        deliveryId: stop.deliveryId,
        status: stop.status,
        source: stop.source,
        skipReason: stop.skipReason,
        failReason: stop.failReason,
        items: stop.items.map((item) => ({
          productId: item.productId,
          productName: item.product.name,
          baseUnit: item.product.baseUnit,
          allowFractionalQty: item.product.allowFractionalQty,
          plannedQuantity: decimalQtyToNumber(item.plannedQuantity),
        })),
        createdAt: stop.createdAt,
        updatedAt: stop.updatedAt,
      })),
    };
  }
}
