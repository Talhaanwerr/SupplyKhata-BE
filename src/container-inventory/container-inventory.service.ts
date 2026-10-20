import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ContainerMovementType as PrismaContainerMovementType,
  DeliveryStatus as PrismaDeliveryStatus,
  RunStatus as PrismaRunStatus,
  StockType as PrismaStockType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  customerContainerSignedQty,
  ownedPoolSignedQty,
} from '../common/helpers/container-balance.helper';
import {
  assertReturnableContainersEnabled,
  isReturnableContainersEnabled,
} from '../common/helpers/returnable-containers.helper';
import { SetContainerOpeningDto } from './dto/set-container-opening.dto';
import { AdjustOwnedContainersDto } from './dto/adjust-owned-containers.dto';

@Injectable()
export class ContainerInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async inventory(tenantId: string) {
    if (!(await isReturnableContainersEnabled(this.prisma, tenantId))) {
      return [];
    }

    const packagingTypes = await this.prisma.packagingType.findMany({
      where: { tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        capacity: true,
        isActive: true,
        products: {
          where: { deletedAt: null, isReturnable: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    if (packagingTypes.length === 0) return [];

    const packagingTypeIds = packagingTypes.map((p) => p.id);
    const productIds = packagingTypes.flatMap((p) => p.products.map((prod) => prod.id));
    const productToType = new Map<string, string>();
    for (const type of packagingTypes) {
      for (const product of type.products) {
        productToType.set(product.id, type.id);
      }
    }

    const openRuns = await this.prisma.deliveryRun.findMany({
      where: { tenantId, status: PrismaRunStatus.OPEN },
      select: { id: true },
    });
    const openRunIds = openRuns.map((run) => run.id);

    const [
      ownedMovements,
      customerMovements,
      packagingVehicleStock,
      vehicleStock,
      deliveredOnOpenRuns,
    ] = await Promise.all([
      this.prisma.containerMovement.findMany({
        where: {
          tenantId,
          packagingTypeId: { in: packagingTypeIds },
          customerId: null,
          vehicleId: null,
          movementType: {
            in: [
              PrismaContainerMovementType.OPENING_ON_HAND,
              PrismaContainerMovementType.ADJUSTMENT,
              PrismaContainerMovementType.LOST,
              PrismaContainerMovementType.DAMAGED,
            ],
          },
        },
        select: { packagingTypeId: true, movementType: true, quantity: true },
      }),
      this.prisma.containerMovement.findMany({
        where: {
          tenantId,
          packagingTypeId: { in: packagingTypeIds },
          customerId: { not: null },
        },
        select: {
          packagingTypeId: true,
          customerId: true,
          movementType: true,
          quantity: true,
          customer: { select: { id: true, name: true, deletedAt: true } },
        },
      }),
      openRunIds.length === 0
        ? Promise.resolve([] as Array<{ packagingTypeId: string; filledCount: number }>)
        : this.prisma.deliveryRunPackagingStock.findMany({
            where: {
              tenantId,
              stockType: PrismaStockType.OPENING,
              packagingTypeId: { in: packagingTypeIds },
              deliveryRunId: { in: openRunIds },
            },
            select: { packagingTypeId: true, filledCount: true },
          }),
      openRunIds.length === 0 || productIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              productId: string;
              filledPackagingCount: number;
            }>,
          )
        : this.prisma.deliveryRunStock.findMany({
            where: {
              tenantId,
              stockType: PrismaStockType.OPENING,
              productId: { in: productIds },
              deliveryRunId: { in: openRunIds },
            },
            select: { productId: true, filledPackagingCount: true },
          }),
      openRunIds.length === 0 || productIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              productId: string;
              containersDelivered: number;
            }>,
          )
        : this.prisma.deliveryItem.findMany({
            where: {
              tenantId,
              productId: { in: productIds },
              containersDelivered: { gt: 0 },
              delivery: {
                tenantId,
                deliveryRunId: { in: openRunIds },
                status: { not: PrismaDeliveryStatus.CANCELLED },
              },
            },
            select: { productId: true, containersDelivered: true },
          }),
    ]);

    const ownedByType = new Map<string, number>();
    const hasOpeningByType = new Map<string, boolean>();
    for (const m of ownedMovements) {
      if (!m.packagingTypeId) continue;
      if (m.movementType === PrismaContainerMovementType.OPENING_ON_HAND) {
        hasOpeningByType.set(m.packagingTypeId, true);
      }
      ownedByType.set(
        m.packagingTypeId,
        (ownedByType.get(m.packagingTypeId) ?? 0) + ownedPoolSignedQty(m.movementType, m.quantity),
      );
    }

    const withCustomersByType = new Map<string, number>();
    const holdingByType = new Map<
      string,
      Map<string, { customerId: string; customerName: string; balance: number }>
    >();

    for (const m of customerMovements) {
      if (!m.packagingTypeId || !m.customerId || m.customer?.deletedAt) continue;
      const signed = customerContainerSignedQty(m.movementType, m.quantity);
      withCustomersByType.set(
        m.packagingTypeId,
        (withCustomersByType.get(m.packagingTypeId) ?? 0) + signed,
      );

      let perCustomer = holdingByType.get(m.packagingTypeId);
      if (!perCustomer) {
        perCustomer = new Map();
        holdingByType.set(m.packagingTypeId, perCustomer);
      }
      const prev = perCustomer.get(m.customerId) ?? {
        customerId: m.customerId,
        customerName: m.customer?.name ?? 'Customer',
        balance: 0,
      };
      prev.balance += signed;
      perCustomer.set(m.customerId, prev);
    }

    const onVehiclesByType = new Map<string, number>();
    const typesWithPackagingRunStock = new Set(packagingVehicleStock.map((r) => r.packagingTypeId));
    for (const row of packagingVehicleStock) {
      onVehiclesByType.set(
        row.packagingTypeId,
        (onVehiclesByType.get(row.packagingTypeId) ?? 0) + row.filledCount,
      );
    }
    // Legacy fallback: product filledPackagingCount when run has no packaging stock rows.
    for (const row of vehicleStock) {
      const typeId = productToType.get(row.productId);
      if (!typeId || typesWithPackagingRunStock.has(typeId)) continue;
      onVehiclesByType.set(typeId, (onVehiclesByType.get(typeId) ?? 0) + row.filledPackagingCount);
    }
    for (const row of deliveredOnOpenRuns) {
      const typeId = productToType.get(row.productId);
      if (!typeId) continue;
      onVehiclesByType.set(typeId, (onVehiclesByType.get(typeId) ?? 0) - row.containersDelivered);
    }

    return packagingTypes.map((type) => {
      const ownedTotal = ownedByType.get(type.id) ?? 0;
      const withCustomers = withCustomersByType.get(type.id) ?? 0;
      const onVehicles = onVehiclesByType.get(type.id) ?? 0;
      const onHand = ownedTotal - withCustomers - onVehicles;
      const customersHolding = [...(holdingByType.get(type.id)?.values() ?? [])]
        .filter((row) => row.balance > 0)
        .sort((a, b) => b.balance - a.balance || a.customerName.localeCompare(b.customerName));
      const capacity =
        type.capacity == null
          ? null
          : typeof type.capacity === 'number'
            ? type.capacity
            : Number(type.capacity.toString());

      return {
        packagingTypeId: type.id,
        name: type.name,
        capacity,
        ownedTotal,
        withCustomers,
        onVehicles,
        onHand,
        hasOpeningOnHand: hasOpeningByType.get(type.id) ?? false,
        customersHolding,
        productNames: type.products.map((p) => p.name),
      };
    });
  }

  async setOpening(tenantId: string, dto: SetContainerOpeningDto, actorId: string) {
    await assertReturnableContainersEnabled(this.prisma, tenantId);
    const ids = dto.items.map((item) => item.packagingTypeId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each packaging type can appear only once');
    }
    await this.assertActivePackagingTypes(tenantId, ids);

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        const existing = await tx.containerMovement.findFirst({
          where: {
            tenantId,
            packagingTypeId: item.packagingTypeId,
            customerId: null,
            vehicleId: null,
            movementType: PrismaContainerMovementType.OPENING_ON_HAND,
          },
          select: { id: true },
        });
        if (existing) {
          throw new BadRequestException(
            'Opening owned stock already set for one or more packaging types — use adjustment instead',
          );
        }
        await tx.containerMovement.create({
          data: {
            tenantId,
            packagingTypeId: item.packagingTypeId,
            productId: null,
            quantity: item.quantity,
            movementType: PrismaContainerMovementType.OPENING_ON_HAND,
            notes: 'Opening owned fleet stock',
          },
        });
      }
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'containers',
      action: 'CREATE',
      entityId: tenantId,
      newValue: { opening: dto.items },
    });

    return this.inventory(tenantId);
  }

  async adjustOwned(tenantId: string, dto: AdjustOwnedContainersDto, actorId: string) {
    if (dto.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta must be non-zero');
    }
    await assertReturnableContainersEnabled(this.prisma, tenantId);
    await this.assertActivePackagingTypes(tenantId, [dto.packagingTypeId]);

    const movementType = dto.movementType ?? PrismaContainerMovementType.ADJUSTMENT;
    const allowed: PrismaContainerMovementType[] = [
      PrismaContainerMovementType.ADJUSTMENT,
      PrismaContainerMovementType.LOST,
      PrismaContainerMovementType.DAMAGED,
    ];
    if (!allowed.includes(movementType as PrismaContainerMovementType)) {
      throw new BadRequestException('movementType must be ADJUSTMENT, LOST, or DAMAGED');
    }

    const isWriteOff =
      movementType === PrismaContainerMovementType.LOST ||
      movementType === PrismaContainerMovementType.DAMAGED;
    if (isWriteOff && dto.quantityDelta < 0) {
      throw new BadRequestException('LOST / DAMAGED quantity must be a positive can count');
    }

    const quantity = isWriteOff ? Math.abs(dto.quantityDelta) : dto.quantityDelta;
    const defaultNote = isWriteOff
      ? `Owned fleet write-off (${movementType})`
      : 'Owned fleet adjustment';

    const movement = await this.prisma.containerMovement.create({
      data: {
        tenantId,
        packagingTypeId: dto.packagingTypeId,
        productId: null,
        quantity,
        movementType: movementType as PrismaContainerMovementType,
        notes: dto.notes?.trim() || defaultNote,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'containers',
      action: isWriteOff ? 'WRITE_OFF' : 'UPDATE',
      entityId: movement.id,
      newValue: {
        packagingTypeId: dto.packagingTypeId,
        quantityDelta: isWriteOff ? -quantity : dto.quantityDelta,
        movementType,
      },
    });

    return this.inventory(tenantId);
  }

  private async assertActivePackagingTypes(tenantId: string, packagingTypeIds: string[]) {
    const count = await this.prisma.packagingType.count({
      where: {
        tenantId,
        deletedAt: null,
        isActive: true,
        id: { in: packagingTypeIds },
      },
    });
    if (count !== packagingTypeIds.length) {
      throw new BadRequestException('All packaging types must be active in this workspace');
    }
  }
}
