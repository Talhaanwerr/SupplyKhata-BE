import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PlannedStopSource, PlannedStopStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { assertValidBaseQuantity, decimalQtyToNumber } from '../common/helpers/product-qty.helper';
import {
  addDays,
  endOfDay,
  parseCalendarDate,
  startOfDay,
  todayStart,
} from '../common/helpers/calendar-date.helper';
import { UpsertDeliveryScheduleDto } from './dto/upsert-delivery-schedule.dto';
import {
  CreateManualPlannedStopDto,
  IncludePlannedStopsDto,
  ListPlannedStopsQueryDto,
  SkipFailPlannedStopDto,
  UpdatePlannedStopDto,
} from './dto/planned-stops.dto';

type Tx = Prisma.TransactionClient;

const UPCOMING: PlannedStopStatus[] = [PlannedStopStatus.PLANNED, PlannedStopStatus.INCLUDED];

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  // ─── Schedule CRUD ─────────────────────────────────────────

  async getSchedule(customerId: string, tenantId: string) {
    await this.assertCustomer(customerId, tenantId);
    const schedule = await this.prisma.customerDeliverySchedule.findUnique({
      where: { tenantId_customerId: { tenantId, customerId } },
      include: this.scheduleInclude(),
    });
    return schedule ? this.toSchedule(schedule) : null;
  }

  async upsertSchedule(
    customerId: string,
    tenantId: string,
    dto: UpsertDeliveryScheduleDto,
    actorId: string,
  ) {
    await this.assertCustomer(customerId, tenantId);
    if (dto.intervalDays < 1) {
      throw new BadRequestException('intervalDays must be >= 1');
    }

    const products = await this.loadProducts(
      tenantId,
      dto.items.map((i) => i.productId),
    );
    for (const item of dto.items) {
      const product = products.get(item.productId);
      if (!product) throw new BadRequestException(`Unknown product ${item.productId}`);
      assertValidBaseQuantity(item.defaultQuantity, product);
    }

    const defaultRiderId = dto.defaultRiderId?.trim() || null;
    if (defaultRiderId) {
      const rider = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId: defaultRiderId, tenantId } },
      });
      if (!rider) {
        throw new BadRequestException('Selected default rider is not a member of this workspace');
      }
    }

    const isActive = dto.isActive ?? true;
    const startDate = dto.startDate ? parseCalendarDate(dto.startDate) : null;

    const schedule = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerDeliverySchedule.findUnique({
        where: { tenantId_customerId: { tenantId, customerId } },
      });

      const saved = existing
        ? await tx.customerDeliverySchedule.update({
            where: { id: existing.id },
            data: {
              intervalDays: dto.intervalDays,
              isActive,
              startDate,
              defaultRiderId,
              notes: dto.notes?.trim() || null,
            },
          })
        : await tx.customerDeliverySchedule.create({
            data: {
              tenantId,
              customerId,
              intervalDays: dto.intervalDays,
              isActive,
              startDate,
              defaultRiderId,
              notes: dto.notes?.trim() || null,
            },
          });

      await tx.customerDeliveryScheduleItem.deleteMany({ where: { scheduleId: saved.id } });
      if (dto.items.length > 0) {
        await tx.customerDeliveryScheduleItem.createMany({
          data: dto.items.map((item) => ({
            tenantId,
            scheduleId: saved.id,
            productId: item.productId,
            defaultQuantity: item.defaultQuantity,
          })),
        });
      }

      if (!isActive) {
        await tx.plannedDeliveryStop.updateMany({
          where: {
            tenantId,
            scheduleId: saved.id,
            status: PlannedStopStatus.PLANNED,
          },
          data: { status: PlannedStopStatus.CANCELLED },
        });
      } else {
        await this.ensureUpcomingStop(tx, tenantId, saved.id, {
          preferStartDate: startDate,
          refreshItems: true,
        });
      }

      return tx.customerDeliverySchedule.findUniqueOrThrow({
        where: { id: saved.id },
        include: this.scheduleInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'schedules',
      action: 'UPDATE',
      entityId: schedule.id,
      newValue: { customerId, intervalDays: dto.intervalDays, isActive },
    });

    return this.toSchedule(schedule);
  }

  async getDeliveryContext(customerId: string, tenantId: string) {
    await this.assertCustomer(customerId, tenantId);
    const schedule = await this.prisma.customerDeliverySchedule.findUnique({
      where: { tenantId_customerId: { tenantId, customerId } },
      select: { id: true, isActive: true },
    });
    if (schedule?.isActive) {
      await this.prisma.$transaction((tx) =>
        this.ensureUpcomingStop(tx, tenantId, schedule.id, { refreshItems: false }),
      );
    }

    const upcoming = await this.prisma.plannedDeliveryStop.findFirst({
      where: {
        tenantId,
        customerId,
        status: { in: UPCOMING },
        planDate: { gte: todayStart() },
      },
      orderBy: { planDate: 'asc' },
      include: this.stopInclude(),
    });

    return {
      upcomingPlannedStop: upcoming ? this.toStop(upcoming) : null,
    };
  }

  // ─── Daily list ────────────────────────────────────────────

  async listPlannedStops(tenantId: string, query: ListPlannedStopsQueryDto) {
    const day = parseCalendarDate(query.date);
    const dayEnd = endOfDay(day);

    await this.lazyEnsureActiveSchedules(tenantId);

    const where: Prisma.PlannedDeliveryStopWhereInput = {
      tenantId,
      planDate: { gte: day, lte: dayEnd },
    };
    if (query.status) where.status = query.status;
    if (query.areaId || query.search || query.riderId) {
      where.customer = {
        ...(query.areaId ? { areaId: query.areaId } : {}),
        ...(query.riderId ? { defaultRiderId: query.riderId } : {}),
        ...(query.search
          ? {
              OR: [{ name: { contains: query.search } }, { phone: { contains: query.search } }],
            }
          : {}),
      };
    }

    const stops = await this.prisma.plannedDeliveryStop.findMany({
      where,
      orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }],
      include: this.stopInclude(),
    });

    return { items: stops.map((s) => this.toStop(s)), date: query.date };
  }

  async createManualStop(tenantId: string, dto: CreateManualPlannedStopDto, actorId: string) {
    await this.assertCustomer(dto.customerId, tenantId);
    const products = await this.loadProducts(
      tenantId,
      dto.items.map((i) => i.productId),
    );
    for (const item of dto.items) {
      const product = products.get(item.productId);
      if (!product) throw new BadRequestException(`Unknown product ${item.productId}`);
      assertValidBaseQuantity(item.plannedQuantity, product);
    }

    const stop = await this.prisma.plannedDeliveryStop.create({
      data: {
        tenantId,
        customerId: dto.customerId,
        planDate: parseCalendarDate(dto.planDate),
        status: PlannedStopStatus.PLANNED,
        source: PlannedStopSource.MANUAL,
        items: {
          create: dto.items.map((item) => ({
            tenantId,
            productId: item.productId,
            plannedQuantity: item.plannedQuantity,
          })),
        },
      },
      include: this.stopInclude(),
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'planned-stops',
      action: 'CREATE',
      entityId: stop.id,
      newValue: { customerId: dto.customerId, planDate: dto.planDate, source: 'MANUAL' },
    });

    return this.toStop(stop);
  }

  async updatePlannedStop(
    id: string,
    tenantId: string,
    dto: UpdatePlannedStopDto,
    actorId: string,
  ) {
    const stop = await this.findStopOrThrow(id, tenantId);
    if (stop.status !== PlannedStopStatus.PLANNED && stop.status !== PlannedStopStatus.INCLUDED) {
      throw new BadRequestException('Only PLANNED or INCLUDED stops can be edited');
    }

    if (dto.items?.length) {
      const products = await this.loadProducts(
        tenantId,
        dto.items.map((i) => i.productId),
      );
      for (const item of dto.items) {
        const product = products.get(item.productId);
        if (!product) throw new BadRequestException(`Unknown product ${item.productId}`);
        assertValidBaseQuantity(item.plannedQuantity, product);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.planDate) {
        await tx.plannedDeliveryStop.update({
          where: { id },
          data: { planDate: parseCalendarDate(dto.planDate) },
        });
      }
      if (dto.items) {
        await tx.plannedDeliveryStopItem.deleteMany({ where: { plannedStopId: id } });
        await tx.plannedDeliveryStopItem.createMany({
          data: dto.items.map((item) => ({
            tenantId,
            plannedStopId: id,
            productId: item.productId,
            plannedQuantity: item.plannedQuantity,
          })),
        });
      }
      return tx.plannedDeliveryStop.findUniqueOrThrow({
        where: { id },
        include: this.stopInclude(),
      });
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'planned-stops',
      action: 'UPDATE',
      entityId: id,
      newValue: { planDate: dto.planDate, itemsUpdated: Boolean(dto.items) },
    });

    return this.toStop(updated);
  }

  async skipStop(id: string, tenantId: string, dto: SkipFailPlannedStopDto, actorId: string) {
    return this.terminalAdvance(id, tenantId, PlannedStopStatus.SKIPPED, dto.reason, actorId);
  }

  async failStop(id: string, tenantId: string, dto: SkipFailPlannedStopDto, actorId: string) {
    return this.terminalAdvance(id, tenantId, PlannedStopStatus.FAILED, dto.reason, actorId);
  }

  /**
   * SKIPPED/FAILED: advance cadence from original planDate + intervalDays
   * so the schedule does not die (Phase 2 rule).
   */
  private async terminalAdvance(
    id: string,
    tenantId: string,
    status: 'SKIPPED' | 'FAILED',
    reason: string | undefined,
    actorId: string,
  ) {
    const stop = await this.findStopOrThrow(id, tenantId);
    if (stop.status !== PlannedStopStatus.PLANNED && stop.status !== PlannedStopStatus.INCLUDED) {
      throw new BadRequestException(`Cannot ${status.toLowerCase()} a ${stop.status} stop`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.plannedDeliveryStop.update({
        where: { id },
        data: {
          status,
          skipReason:
            status === PlannedStopStatus.SKIPPED ? reason?.trim() || null : stop.skipReason,
          failReason:
            status === PlannedStopStatus.FAILED ? reason?.trim() || null : stop.failReason,
          deliveryRunId: null,
        },
      });

      if (stop.source === PlannedStopSource.SCHEDULE && stop.scheduleId) {
        const schedule = await tx.customerDeliverySchedule.findFirst({
          where: { id: stop.scheduleId, tenantId, isActive: true },
          include: { items: true },
        });
        if (schedule) {
          // Advance from original planDate + interval (not "today") so cadence stays stable.
          const nextDate = addDays(startOfDay(stop.planDate), schedule.intervalDays);
          await this.createStopIfNoUpcoming(tx, {
            tenantId,
            customerId: stop.customerId,
            scheduleId: schedule.id,
            planDate: nextDate,
            items: schedule.items.map((i) => ({
              productId: i.productId,
              plannedQuantity: decimalQtyToNumber(i.defaultQuantity),
            })),
          });
        }
      }
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'planned-stops',
      action: status === PlannedStopStatus.SKIPPED ? 'SKIP' : 'FAIL',
      entityId: id,
      newValue: { reason },
    });

    return this.findStopDetail(id, tenantId);
  }

  async includeInRun(
    runId: string,
    tenantId: string,
    dto: IncludePlannedStopsDto,
    actorId: string,
  ) {
    const run = await this.prisma.deliveryRun.findFirst({
      where: { id: runId, tenantId },
    });
    if (!run) throw new NotFoundException('Delivery run not found');
    if (run.status !== 'OPEN') {
      throw new BadRequestException('Can only include planned stops into an OPEN run');
    }

    const runDay = startOfDay(run.date);
    const runDayEnd = endOfDay(runDay);

    const stops = await this.prisma.plannedDeliveryStop.findMany({
      where: {
        tenantId,
        id: { in: dto.plannedStopIds },
        status: PlannedStopStatus.PLANNED,
      },
    });
    if (stops.length !== dto.plannedStopIds.length) {
      throw new BadRequestException('One or more stops are missing or not PLANNED');
    }
    for (const stop of stops) {
      if (stop.planDate < runDay || stop.planDate > runDayEnd) {
        throw new BadRequestException('Planned stop date must match the delivery run date');
      }
    }

    await this.prisma.plannedDeliveryStop.updateMany({
      where: { id: { in: dto.plannedStopIds }, tenantId },
      data: { status: PlannedStopStatus.INCLUDED, deliveryRunId: runId },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'planned-stops',
      action: 'INCLUDE',
      entityId: runId,
      newValue: { plannedStopIds: dto.plannedStopIds },
    });

    const updated = await this.prisma.plannedDeliveryStop.findMany({
      where: { id: { in: dto.plannedStopIds } },
      include: this.stopInclude(),
    });
    return { items: updated.map((s) => this.toStop(s)) };
  }

  /**
   * Called inside delivery create transaction after delivery row exists.
   * Marks stop COMPLETED and spawns next PLANNED at deliveryDate + intervalDays.
   */
  async completeStopInTx(
    tx: Tx,
    args: {
      tenantId: string;
      plannedStopId: string;
      deliveryId: string;
      customerId: string;
      deliveryDate: Date;
    },
  ): Promise<string | null> {
    const stop = await tx.plannedDeliveryStop.findFirst({
      where: { id: args.plannedStopId, tenantId: args.tenantId },
    });
    if (!stop) throw new BadRequestException('Planned stop not found');
    if (stop.customerId !== args.customerId) {
      throw new BadRequestException('Planned stop customer mismatch');
    }
    if (stop.status !== PlannedStopStatus.PLANNED && stop.status !== PlannedStopStatus.INCLUDED) {
      throw new BadRequestException(`Cannot complete a ${stop.status} planned stop`);
    }

    await tx.plannedDeliveryStop.update({
      where: { id: stop.id },
      data: {
        status: PlannedStopStatus.COMPLETED,
        deliveryId: args.deliveryId,
      },
    });

    if (stop.source !== PlannedStopSource.SCHEDULE || !stop.scheduleId) {
      // Manual stops: also advance if customer has an active schedule.
      const schedule = await tx.customerDeliverySchedule.findUnique({
        where: {
          tenantId_customerId: { tenantId: args.tenantId, customerId: args.customerId },
        },
        include: { items: true },
      });
      if (!schedule?.isActive) return null;
      const nextDate = addDays(startOfDay(args.deliveryDate), schedule.intervalDays);
      return this.createStopIfNoUpcoming(tx, {
        tenantId: args.tenantId,
        customerId: args.customerId,
        scheduleId: schedule.id,
        planDate: nextDate,
        items: schedule.items.map((i) => ({
          productId: i.productId,
          plannedQuantity: decimalQtyToNumber(i.defaultQuantity),
        })),
      });
    }

    const schedule = await tx.customerDeliverySchedule.findFirst({
      where: { id: stop.scheduleId, tenantId: args.tenantId, isActive: true },
      include: { items: true },
    });
    if (!schedule) return null;

    // nextPlanDate = actualDeliveryDate + intervalDays (NOT original planDate).
    const nextDate = addDays(startOfDay(args.deliveryDate), schedule.intervalDays);
    return this.createStopIfNoUpcoming(tx, {
      tenantId: args.tenantId,
      customerId: args.customerId,
      scheduleId: schedule.id,
      planDate: nextDate,
      items: schedule.items.map((i) => ({
        productId: i.productId,
        plannedQuantity: decimalQtyToNumber(i.defaultQuantity),
      })),
    });
  }

  /**
   * On delivery cancel: revert linked stop to INCLUDED and delete untouched
   * auto-spawned NEXT PLANNED stop created from this completion.
   */
  async revertStopOnDeliveryCancelInTx(
    tx: Tx,
    args: { tenantId: string; deliveryId: string; customerId: string },
  ): Promise<void> {
    const stop = await tx.plannedDeliveryStop.findFirst({
      where: { tenantId: args.tenantId, deliveryId: args.deliveryId },
    });
    if (!stop || stop.status !== PlannedStopStatus.COMPLETED) return;

    await tx.plannedDeliveryStop.update({
      where: { id: stop.id },
      data: {
        status: PlannedStopStatus.INCLUDED,
        deliveryId: null,
      },
    });

    // Delete auto-spawned next if still PLANNED and untouched (no run link).
    const next = await tx.plannedDeliveryStop.findFirst({
      where: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        scheduleId: stop.scheduleId ?? undefined,
        status: PlannedStopStatus.PLANNED,
        deliveryRunId: null,
        source: PlannedStopSource.SCHEDULE,
        createdAt: { gt: stop.updatedAt },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (next) {
      await tx.plannedDeliveryStopItem.deleteMany({ where: { plannedStopId: next.id } });
      await tx.plannedDeliveryStop.delete({ where: { id: next.id } });
    }
  }

  // ─── Internals ─────────────────────────────────────────────

  private async lazyEnsureActiveSchedules(tenantId: string) {
    const schedules = await this.prisma.customerDeliverySchedule.findMany({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    if (schedules.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const s of schedules) {
        await this.ensureUpcomingStop(tx, tenantId, s.id, { refreshItems: false });
      }
    });
  }

  private async ensureUpcomingStop(
    tx: Tx,
    tenantId: string,
    scheduleId: string,
    opts: { preferStartDate?: Date | null; refreshItems: boolean },
  ) {
    const schedule = await tx.customerDeliverySchedule.findFirst({
      where: { id: scheduleId, tenantId, isActive: true },
      include: { items: true },
    });
    if (!schedule) return;

    const upcoming = await tx.plannedDeliveryStop.findFirst({
      where: {
        tenantId,
        customerId: schedule.customerId,
        scheduleId,
        status: { in: UPCOMING },
        source: PlannedStopSource.SCHEDULE,
      },
    });

    if (upcoming) {
      if (opts.refreshItems && upcoming.status === PlannedStopStatus.PLANNED) {
        await tx.plannedDeliveryStopItem.deleteMany({ where: { plannedStopId: upcoming.id } });
        if (schedule.items.length > 0) {
          await tx.plannedDeliveryStopItem.createMany({
            data: schedule.items.map((i) => ({
              tenantId,
              plannedStopId: upcoming.id,
              productId: i.productId,
              plannedQuantity: i.defaultQuantity,
            })),
          });
        }
        if (opts.preferStartDate) {
          await tx.plannedDeliveryStop.update({
            where: { id: upcoming.id },
            data: { planDate: opts.preferStartDate },
          });
        }
      }
      return;
    }

    const lastCompleted = await tx.plannedDeliveryStop.findFirst({
      where: {
        tenantId,
        customerId: schedule.customerId,
        scheduleId,
        status: PlannedStopStatus.COMPLETED,
        deliveryId: { not: null },
      },
      orderBy: { planDate: 'desc' },
      include: { completedDelivery: { select: { deliveryDate: true } } },
    });

    let planDate: Date;
    if (lastCompleted?.completedDelivery) {
      planDate = addDays(
        startOfDay(lastCompleted.completedDelivery.deliveryDate),
        schedule.intervalDays,
      );
    } else if (opts.preferStartDate) {
      planDate = opts.preferStartDate;
    } else if (schedule.startDate) {
      planDate = startOfDay(schedule.startDate);
      if (planDate < todayStart()) planDate = todayStart();
    } else {
      planDate = todayStart();
    }

    await this.createStopIfNoUpcoming(tx, {
      tenantId,
      customerId: schedule.customerId,
      scheduleId,
      planDate,
      items: schedule.items.map((i) => ({
        productId: i.productId,
        plannedQuantity: decimalQtyToNumber(i.defaultQuantity),
      })),
    });
  }

  private async createStopIfNoUpcoming(
    tx: Tx,
    args: {
      tenantId: string;
      customerId: string;
      scheduleId: string;
      planDate: Date;
      items: Array<{ productId: string; plannedQuantity: number }>;
    },
  ): Promise<string | null> {
    const existing = await tx.plannedDeliveryStop.findFirst({
      where: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        scheduleId: args.scheduleId,
        status: { in: UPCOMING },
        source: PlannedStopSource.SCHEDULE,
      },
    });
    if (existing) return null;

    const created = await tx.plannedDeliveryStop.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        scheduleId: args.scheduleId,
        planDate: startOfDay(args.planDate),
        status: PlannedStopStatus.PLANNED,
        source: PlannedStopSource.SCHEDULE,
        items: {
          create: args.items
            .filter((i) => i.plannedQuantity > 0)
            .map((item) => ({
              tenantId: args.tenantId,
              productId: item.productId,
              plannedQuantity: item.plannedQuantity,
            })),
        },
      },
    });
    return created.id;
  }

  private async assertCustomer(customerId: string, tenantId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
  }

  private async loadProducts(tenantId: string, productIds: string[]) {
    const unique = [...new Set(productIds)];
    if (unique.length === 0)
      return new Map<string, { name: string; allowFractionalQty: boolean }>();
    const rows = await this.prisma.product.findMany({
      where: { tenantId, id: { in: unique }, deletedAt: null },
      select: { id: true, name: true, allowFractionalQty: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async findStopOrThrow(id: string, tenantId: string) {
    const stop = await this.prisma.plannedDeliveryStop.findFirst({
      where: { id, tenantId },
    });
    if (!stop) throw new NotFoundException('Planned stop not found');
    return stop;
  }

  private async findStopDetail(id: string, tenantId: string) {
    const stop = await this.prisma.plannedDeliveryStop.findFirst({
      where: { id, tenantId },
      include: this.stopInclude(),
    });
    if (!stop) throw new NotFoundException('Planned stop not found');
    return this.toStop(stop);
  }

  private scheduleInclude() {
    return {
      items: {
        include: {
          product: { select: { id: true, name: true, baseUnit: true, allowFractionalQty: true } },
        },
      },
      defaultRider: { select: { id: true, firstName: true, lastName: true } },
    } as const;
  }

  private stopInclude() {
    return {
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          areaId: true,
          area: { select: { id: true, name: true } },
          defaultRiderId: true,
        },
      },
      items: {
        include: {
          product: { select: { id: true, name: true, baseUnit: true, allowFractionalQty: true } },
        },
      },
      schedule: { select: { id: true, intervalDays: true, isActive: true } },
    } as const;
  }

  private toSchedule(
    schedule: Prisma.CustomerDeliveryScheduleGetPayload<{
      include: ReturnType<SchedulingService['scheduleInclude']>;
    }>,
  ) {
    return {
      id: schedule.id,
      customerId: schedule.customerId,
      intervalDays: schedule.intervalDays,
      isActive: schedule.isActive,
      startDate: schedule.startDate?.toISOString().slice(0, 10) ?? null,
      defaultRiderId: schedule.defaultRiderId,
      defaultRider: schedule.defaultRider
        ? {
            id: schedule.defaultRider.id,
            name: `${schedule.defaultRider.firstName} ${schedule.defaultRider.lastName}`.trim(),
          }
        : null,
      notes: schedule.notes,
      items: schedule.items.map((item) => ({
        productId: item.productId,
        productName: item.product.name,
        baseUnit: item.product.baseUnit,
        allowFractionalQty: item.product.allowFractionalQty,
        defaultQuantity: decimalQtyToNumber(item.defaultQuantity),
      })),
      updatedAt: schedule.updatedAt.toISOString(),
    };
  }

  private toStop(
    stop: Prisma.PlannedDeliveryStopGetPayload<{
      include: ReturnType<SchedulingService['stopInclude']>;
    }>,
  ) {
    return {
      id: stop.id,
      planDate: stop.planDate.toISOString().slice(0, 10),
      customerId: stop.customerId,
      customerName: stop.customer.name,
      customerPhone: stop.customer.phone,
      areaId: stop.customer.areaId,
      areaName: stop.customer.area?.name ?? null,
      scheduleId: stop.scheduleId,
      intervalDays: stop.schedule?.intervalDays ?? null,
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
    };
  }
}
