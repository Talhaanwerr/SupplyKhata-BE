import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

export interface WriteAuditLogParams {
  actorId?: string | null;
  tenantId?: string | null;
  action: string;
  module: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type AuditLogListItem = {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  module: string;
  action: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  tenant: { id: string; name: string; slug: string } | null;
};

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Write ─────────────────────────────────────────────────────────────

  async write(params: WriteAuditLogParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.actorId ?? null,
          tenantId: params.tenantId ?? null,
          action: params.action,
          module: params.module,
          entityId: params.entityId ?? null,
          oldValue: this.toJson(params.oldValue),
          newValue: this.toJson(params.newValue),
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        },
      });
    } catch (err) {
      // Audit failure must never break the main business flow
      this.logger.error(
        `Failed to write audit log [${params.module}:${params.action}]: ${String(err)}`,
      );
    }
  }

  // ─── List ──────────────────────────────────────────────────────────────

  async findAll(
    query: ListAuditLogsQueryDto,
    actorTenantId: string | null,
    isSuperAdmin: boolean,
  ): Promise<PaginatedData<AuditLogListItem>> {
    const { skip, take } = getPaginationParams(query);
    const where = this.buildWhere(query, actorTenantId, isSuperAdmin);

    const [rawItems, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
          tenant: { select: { id: true, name: true, slug: true } },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const items = await this.mapItems(rawItems);

    return {
      items,
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private buildWhere(
    query: ListAuditLogsQueryDto,
    actorTenantId: string | null,
    isSuperAdmin: boolean,
  ): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};

    if (isSuperAdmin) {
      // Super Admin page should show platform-admin activity only,
      // not day-to-day tenant user activity.
      where.user = { isSuperAdmin: true };
      if (query.tenantId) where.tenantId = query.tenantId;
    } else if (!isSuperAdmin) {
      const hiddenModules = ['tenants', 'subscriptions', 'feature-flags'];
      where.tenantId = actorTenantId;
      // Only workspace member activity — hide SA bootstrap / platform modules
      where.user = { isSuperAdmin: false };
      const mod = query.module?.trim();
      if (mod && !hiddenModules.includes(mod)) {
        where.module = mod;
      } else {
        where.module = { notIn: hiddenModules };
      }
    }

    if (isSuperAdmin && query.module?.trim()) where.module = query.module.trim();
    if (query.action?.trim()) where.action = query.action.trim();
    if (query.userId) where.userId = query.userId;

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { module: { contains: search } },
        { action: { contains: search } },
        { entityId: { contains: search } },
        { user: { email: { contains: search } } },
        { user: { firstName: { contains: search } } },
        { user: { lastName: { contains: search } } },
        { tenant: { name: { contains: search } } },
        { tenant: { slug: { contains: search } } },
      ];
    }

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    return where;
  }

  private async mapItems(
    rawItems: Array<{
      id: string;
      tenantId: string | null;
      userId: string | null;
      action: string;
      module: string;
      entityId: string | null;
      oldValue: unknown;
      newValue: unknown;
      ipAddress: string | null;
      userAgent: string | null;
      createdAt: Date;
      user: { id: string; email: string; firstName: string; lastName: string } | null;
      tenant: { id: string; name: string; slug: string } | null;
    }>,
  ): Promise<AuditLogListItem[]> {
    // Enrich rows that stored tenant info only in entityId / newValue (legacy writes)
    const missingIds = new Set<string>();
    for (const item of rawItems) {
      if (item.tenant) continue;
      if (item.module === 'tenants' && item.entityId) missingIds.add(item.entityId);
      const nv = item.newValue;
      if (nv && typeof nv === 'object' && nv !== null && 'tenantId' in nv) {
        const tid = (nv as { tenantId?: unknown }).tenantId;
        if (typeof tid === 'string') missingIds.add(tid);
      }
    }

    const extras =
      missingIds.size > 0
        ? await this.prisma.tenant.findMany({
            where: { id: { in: [...missingIds] } },
            select: { id: true, name: true, slug: true },
          })
        : [];
    const extraMap = new Map(extras.map((t) => [t.id, t]));

    return rawItems.map((item) => {
      let tenant = item.tenant;
      if (!tenant) {
        if (item.module === 'tenants' && item.entityId) {
          tenant = extraMap.get(item.entityId) ?? null;
        } else {
          const nv = item.newValue;
          if (nv && typeof nv === 'object' && nv !== null && 'tenantId' in nv) {
            const tid = (nv as { tenantId?: unknown }).tenantId;
            if (typeof tid === 'string') tenant = extraMap.get(tid) ?? null;
          }
        }
      }

      const actorName = item.user ? `${item.user.firstName} ${item.user.lastName}`.trim() : null;

      return {
        id: item.id,
        tenantId: item.tenantId ?? tenant?.id ?? null,
        actorId: item.userId,
        actorEmail: item.user?.email ?? null,
        actorName: actorName || null,
        module: item.module,
        action: item.action,
        entityId: item.entityId,
        oldValue: item.oldValue,
        newValue: item.newValue,
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
        createdAt: item.createdAt,
        tenant,
      };
    });
  }

  /** Serialize to plain JSON-compatible data for Prisma Json columns. */
  private toJson(value: unknown) {
    if (value === undefined || value === null) return undefined;
    return JSON.parse(JSON.stringify(value));
  }
}
