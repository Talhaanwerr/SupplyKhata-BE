import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ContainerMovementType as PrismaContainerMovementType,
  Prisma,
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

function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

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

    const products = await this.prisma.product.findMany({
      where: { tenantId, deletedAt: null, isReturnable: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (products.length === 0) return [];

    const productIds = products.map((p) => p.id);

    const openRuns = await this.prisma.deliveryRun.findMany({
      where: { tenantId, status: PrismaRunStatus.OPEN },
      select: { id: true },
    });
    const openRunIds = openRuns.map((run) => run.id);

    const [ownedMovements, customerMovements, vehicleStock] = await Promise.all([
      this.prisma.containerMovement.findMany({
        where: {
          tenantId,
          productId: { in: productIds },
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
        select: { productId: true, movementType: true, quantity: true },
      }),
      this.prisma.containerMovement.findMany({
        where: {
          tenantId,
          productId: { in: productIds },
          customerId: { not: null },
        },
        select: {
          productId: true,
          customerId: true,
          movementType: true,
          quantity: true,
          customer: { select: { id: true, name: true, deletedAt: true } },
        },
      }),
      openRunIds.length === 0
        ? Promise.resolve(
            [] as Array<{ productId: string; _sum: { filledCount: Prisma.Decimal | null } }>,
          )
        : this.prisma.deliveryRunStock.groupBy({
            by: ['productId'],
            where: {
              tenantId,
              stockType: PrismaStockType.OPENING,
              productId: { in: productIds },
              deliveryRunId: { in: openRunIds },
            },
            _sum: { filledCount: true },
          }),
    ]);

    const ownedByProduct = new Map<string, number>();
    const hasOpeningByProduct = new Map<string, boolean>();
    for (const m of ownedMovements) {
      if (m.movementType === PrismaContainerMovementType.OPENING_ON_HAND) {
        hasOpeningByProduct.set(m.productId, true);
      }
      ownedByProduct.set(
        m.productId,
        (ownedByProduct.get(m.productId) ?? 0) + ownedPoolSignedQty(m.movementType, m.quantity),
      );
    }

    const withCustomersByProduct = new Map<string, number>();
    const holdingByProduct = new Map<
      string,
      Map<string, { customerId: string; customerName: string; balance: number }>
    >();

    for (const m of customerMovements) {
      if (!m.customerId || m.customer?.deletedAt) continue;
      const signed = customerContainerSignedQty(m.movementType, m.quantity);
      withCustomersByProduct.set(
        m.productId,
        (withCustomersByProduct.get(m.productId) ?? 0) + signed,
      );

      let perCustomer = holdingByProduct.get(m.productId);
      if (!perCustomer) {
        perCustomer = new Map();
        holdingByProduct.set(m.productId, perCustomer);
      }
      const prev = perCustomer.get(m.customerId) ?? {
        customerId: m.customerId,
        customerName: m.customer?.name ?? 'Customer',
        balance: 0,
      };
      prev.balance += signed;
      perCustomer.set(m.customerId, prev);
    }

    const onVehiclesByProduct = new Map<string, number>();
    for (const row of vehicleStock) {
      onVehiclesByProduct.set(row.productId, decimalToNumber(row._sum.filledCount));
    }

    return products.map((product) => {
      const ownedTotal = ownedByProduct.get(product.id) ?? 0;
      const withCustomers = withCustomersByProduct.get(product.id) ?? 0;
      const onVehicles = onVehiclesByProduct.get(product.id) ?? 0;
      const onHand = ownedTotal - withCustomers - onVehicles;
      const customersHolding = [...(holdingByProduct.get(product.id)?.values() ?? [])]
        .filter((row) => row.balance > 0)
        .sort((a, b) => b.balance - a.balance || a.customerName.localeCompare(b.customerName));

      return {
        productId: product.id,
        productName: product.name,
        ownedTotal,
        withCustomers,
        onVehicles,
        onHand,
        hasOpeningOnHand: hasOpeningByProduct.get(product.id) ?? false,
        customersHolding,
      };
    });
  }

  async setOpening(tenantId: string, dto: SetContainerOpeningDto, actorId: string) {
    await assertReturnableContainersEnabled(this.prisma, tenantId);
    const ids = dto.items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each product can appear only once');
    }
    await this.assertReturnableProducts(tenantId, ids);

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        const existing = await tx.containerMovement.findFirst({
          where: {
            tenantId,
            productId: item.productId,
            customerId: null,
            vehicleId: null,
            movementType: PrismaContainerMovementType.OPENING_ON_HAND,
          },
          select: { id: true },
        });
        if (existing) {
          throw new BadRequestException(
            'Opening owned stock already set for one or more products — use adjustment instead',
          );
        }
        await tx.containerMovement.create({
          data: {
            tenantId,
            productId: item.productId,
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
    await this.assertReturnableProducts(tenantId, [dto.productId]);

    const movement = await this.prisma.containerMovement.create({
      data: {
        tenantId,
        productId: dto.productId,
        quantity: dto.quantityDelta,
        movementType: PrismaContainerMovementType.ADJUSTMENT,
        notes: dto.notes?.trim() || 'Owned fleet adjustment',
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'containers',
      action: 'UPDATE',
      entityId: movement.id,
      newValue: {
        productId: dto.productId,
        quantityDelta: dto.quantityDelta,
      },
    });

    return this.inventory(tenantId);
  }

  private async assertReturnableProducts(tenantId: string, productIds: string[]) {
    const count = await this.prisma.product.count({
      where: {
        tenantId,
        deletedAt: null,
        isActive: true,
        isReturnable: true,
        id: { in: productIds },
      },
    });
    if (count !== productIds.length) {
      throw new BadRequestException(
        'All products must be active returnable products in this workspace',
      );
    }
  }
}
