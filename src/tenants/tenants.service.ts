import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantStatus } from '../common/enums/tenant-status.enum';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UsersService } from '../users/users.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';

type TenantListItem = {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  subdomain: string | null;
  status: TenantStatus;
  timezone: string;
  currency: string;
  logo: string | null;
  ownerUserId: string | null;
  createdAt: Date;
};

type TenantDetail = TenantListItem & {
  subscriptions: {
    id: string;
    status: string;
    startDate: Date;
    endDate: Date | null;
    plan: { id: string; name: string; slug: string };
  }[];
  settings: {
    orgName: string | null;
    timezone: string;
    currency: string;
    invoicePrefix: string;
  } | null;
  _count: { members: number };
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    memberStatus: string;
    emailVerified: boolean;
    emailVerifiedAt: Date | null;
  } | null;
};

type TenantCreateResult = TenantListItem & {
  owner: { id: string; email: string; firstName: string; lastName: string };
};

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly usersService: UsersService,
  ) {}

  // ─── Create + invite owner ────────────────────────────────────

  async create(dto: CreateTenantDto, actorId: string): Promise<TenantCreateResult> {
    await Promise.all([
      this.assertSlugUnique(dto.slug),
      this.assertNameUnique(dto.name),
      dto.subdomain ? this.assertSubdomainUnique(dto.subdomain) : Promise.resolve(),
    ]);

    const ownerEmail = dto.ownerEmail.toLowerCase().trim();
    const timezone = dto.timezone ?? 'Asia/Karachi';
    const currency = dto.currency ?? 'PKR';

    const ownerRole = await this.prisma.role.findFirst({
      where: { slug: 'tenant_owner', tenantId: null, deletedAt: null },
      select: { id: true },
    });
    if (!ownerRole) {
      throw new BadRequestException(
        'System role "tenant_owner" is missing. Run database seed before onboarding tenants.',
      );
    }

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        domain: dto.domain ?? null,
        subdomain: dto.subdomain ?? null,
        timezone,
        currency,
        logo: dto.logo ?? null,
        // Pending until Super Admin activates — owner can accept invite but cannot use the panel yet
        status: TenantStatus.PENDING,
      },
      select: this.listSelect(),
    });

    try {
      // Default workspace settings
      await this.prisma.tenantSettings.create({
        data: {
          tenantId: tenant.id,
          orgName: dto.name,
          timezone,
          currency,
        },
      });

      // Invite owner (new user → set-password email; existing → join notification)
      const owner = await this.usersService.invite(
        {
          email: ownerEmail,
          firstName: dto.ownerFirstName.trim(),
          lastName: dto.ownerLastName.trim(),
          roleIds: [ownerRole.id],
        },
        tenant.id,
        actorId,
      );

      const updated = await this.prisma.tenant.update({
        where: { id: tenant.id },
        data: { ownerUserId: owner.id },
        select: this.listSelect(),
      });

      await this.auditLogs.write({
        actorId,
        tenantId: tenant.id,
        action: 'CREATE',
        module: 'tenants',
        entityId: tenant.id,
        newValue: {
          ...updated,
          ownerEmail: owner.email,
          ownerId: owner.id,
        },
      });

      return {
        ...(updated as TenantListItem),
        owner: {
          id: owner.id,
          email: owner.email,
          firstName: owner.firstName,
          lastName: owner.lastName,
        },
      };
    } catch (err) {
      // Roll back orphan tenant if owner invite fails
      await this.prisma.tenantSettings.deleteMany({ where: { tenantId: tenant.id } });
      await this.prisma.tenantMember.deleteMany({ where: { tenantId: tenant.id } });
      await this.prisma.userRole.deleteMany({ where: { tenantId: tenant.id } });
      await this.prisma.tenant.delete({ where: { id: tenant.id } });
      throw err;
    }
  }

  // ─── Stats ───────────────────────────────────────────────────

  async stats() {
    const [total, active, pending, suspended, cancelled, totalUsers] = await Promise.all([
      this.prisma.tenant.count({ where: { deletedAt: null } }),
      this.prisma.tenant.count({ where: { deletedAt: null, status: TenantStatus.ACTIVE } }),
      this.prisma.tenant.count({ where: { deletedAt: null, status: TenantStatus.PENDING } }),
      this.prisma.tenant.count({ where: { deletedAt: null, status: TenantStatus.SUSPENDED } }),
      this.prisma.tenant.count({ where: { deletedAt: null, status: TenantStatus.CANCELLED } }),
      this.prisma.user.count({ where: { deletedAt: null, isSuperAdmin: false } }),
    ]);
    return { total, active, pending, suspended, cancelled, totalUsers };
  }

  // ─── List ────────────────────────────────────────────────────

  async findAll(query: ListTenantsQueryDto): Promise<PaginatedData<TenantListItem>> {
    const page = query.page;
    const limit = query.limit;
    const { skip, take } = getPaginationParams({ page, limit });

    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { slug: { contains: query.search } },
              { domain: { contains: query.search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: this.listSelect(),
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      items: items as TenantListItem[],
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  // ─── Get One ─────────────────────────────────────────────────

  async findOne(id: string): Promise<TenantDetail> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...this.listSelect(),
        subscriptions: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            plan: { select: { id: true, name: true, slug: true } },
          },
        },
        settings: {
          select: { orgName: true, timezone: true, currency: true, invoicePrefix: true },
        },
        _count: { select: { members: { where: { user: { deletedAt: null } } } } },
      },
    });

    if (!tenant) throw new NotFoundException('Tenant not found');

    let owner: TenantDetail['owner'] = null;
    if (tenant.ownerUserId) {
      const ownerUser = await this.prisma.user.findFirst({
        where: { id: tenant.ownerUserId, deletedAt: null },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          emailVerified: true,
          emailVerifiedAt: true,
        },
      });
      if (ownerUser) {
        const membership = await this.prisma.tenantMember.findUnique({
          where: {
            userId_tenantId: { userId: ownerUser.id, tenantId: id },
          },
          select: { status: true },
        });
        owner = {
          id: ownerUser.id,
          email: ownerUser.email,
          firstName: ownerUser.firstName,
          lastName: ownerUser.lastName,
          memberStatus: membership?.status ?? 'UNKNOWN',
          emailVerified: ownerUser.emailVerified,
          emailVerifiedAt: ownerUser.emailVerifiedAt,
        };
      }
    }

    return { ...(tenant as Omit<TenantDetail, 'owner'>), owner };
  }

  /**
   * Super-admin: re-send owner invite / join email (mail failure or missed inbox).
   */
  async resendOwnerInvite(
    id: string,
    actorId: string,
  ): Promise<{
    emailSent: boolean;
    kind: 'invite' | 'join';
    owner: { id: string; email: string; firstName: string; lastName: string };
  }> {
    const tenant = await this.assertExists(id);

    if (tenant.status === TenantStatus.CANCELLED) {
      throw new BadRequestException('Cannot resend invite for a cancelled tenant');
    }
    if (!tenant.ownerUserId) {
      throw new BadRequestException('This tenant has no owner assigned');
    }

    const result = await this.usersService.resendInviteEmail(tenant.ownerUserId, id, actorId);

    const ownerUser = await this.prisma.user.findFirst({
      where: { id: tenant.ownerUserId, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!ownerUser) {
      throw new NotFoundException('Owner user not found');
    }

    await this.auditLogs.write({
      actorId,
      tenantId: id,
      action: 'UPDATE',
      module: 'tenants',
      entityId: id,
      newValue: {
        type: 'resend-owner-invite',
        email: result.email,
        kind: result.kind,
        emailSent: result.emailSent,
      },
    });

    if (!result.emailSent) {
      throw new BadRequestException(
        `Invite email could not be sent to ${result.email}. Check mail configuration and try again.`,
      );
    }

    return {
      emailSent: true,
      kind: result.kind,
      owner: ownerUser,
    };
  }

  // ─── Update ──────────────────────────────────────────────────

  async update(id: string, dto: UpdateTenantDto, actorId: string): Promise<TenantListItem> {
    const existing = await this.assertExists(id);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameUnique(dto.name, id);
    }
    if (dto.subdomain && dto.subdomain !== existing.subdomain) {
      await this.assertSubdomainUnique(dto.subdomain);
    }

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        name: dto.name,
        domain: dto.domain,
        subdomain: dto.subdomain,
        ownerUserId: dto.ownerUserId,
        timezone: dto.timezone,
        currency: dto.currency,
        logo: dto.logo,
      },
      select: this.listSelect(),
    });

    // Keep TenantSettings in sync when SA edits tenant branding / locale
    const settingsPatch: {
      orgName?: string;
      logo?: string | null;
      timezone?: string;
      currency?: string;
    } = {};
    if (dto.name !== undefined) settingsPatch.orgName = dto.name;
    if (dto.logo !== undefined) settingsPatch.logo = dto.logo ?? null;
    if (dto.timezone !== undefined) settingsPatch.timezone = dto.timezone;
    if (dto.currency !== undefined) settingsPatch.currency = dto.currency;
    if (Object.keys(settingsPatch).length > 0) {
      await this.prisma.tenantSettings.upsert({
        where: { tenantId: id },
        update: settingsPatch,
        create: { tenantId: id, ...settingsPatch },
      });
    }

    await this.auditLogs.write({
      actorId,
      tenantId: id,
      action: 'UPDATE',
      module: 'tenants',
      entityId: id,
      oldValue: existing,
      newValue: updated,
    });

    return updated as TenantListItem;
  }

  // ─── Status transitions ──────────────────────────────────────

  async suspend(id: string, actorId: string): Promise<TenantListItem> {
    return this.changeStatus(id, TenantStatus.SUSPENDED, 'SUSPEND', actorId);
  }

  async activate(id: string, actorId: string): Promise<TenantListItem> {
    return this.changeStatus(id, TenantStatus.ACTIVE, 'ACTIVATE', actorId);
  }

  async cancel(id: string, actorId: string): Promise<TenantListItem> {
    return this.changeStatus(id, TenantStatus.CANCELLED, 'CANCEL', actorId);
  }

  // ─── Delete (soft) ───────────────────────────────────────────

  async delete(id: string, actorId: string): Promise<void> {
    const existing = await this.assertExists(id);

    // Append a short timestamp suffix to slug/subdomain so the DB unique
    // constraint is freed up immediately, allowing the same values to be
    // re-used in a new tenant after deletion.
    const suffix = `_deleted_${Date.now()}`;

    await this.prisma.$transaction([
      this.prisma.userSession.deleteMany({ where: { tenantId: id } }),
      this.prisma.tenant.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          slug: `${existing.slug}${suffix}`,
          subdomain: existing.subdomain ? `${existing.subdomain}${suffix}` : null,
        },
      }),
    ]);

    await this.auditLogs.write({
      actorId,
      tenantId: id,
      action: 'DELETE',
      module: 'tenants',
      entityId: id,
      oldValue: existing,
      newValue: null,
    });
  }

  // ─── Private helpers ─────────────────────────────────────────

  private async changeStatus(
    id: string,
    newStatus: TenantStatus,
    action: string,
    actorId: string,
  ): Promise<TenantListItem> {
    const existing = await this.assertExists(id);

    if (existing.status === newStatus) {
      throw new BadRequestException(`Tenant is already ${newStatus.toLowerCase()}`);
    }

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: newStatus },
      select: this.listSelect(),
    });

    // Kick everyone out of suspended / cancelled workspaces
    if (newStatus === TenantStatus.SUSPENDED || newStatus === TenantStatus.CANCELLED) {
      await this.prisma.userSession.deleteMany({ where: { tenantId: id } });
    }

    await this.auditLogs.write({
      actorId,
      tenantId: id,
      action,
      module: 'tenants',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: { status: newStatus },
    });

    return updated as TenantListItem;
  }

  private async assertExists(id: string): Promise<TenantListItem> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      select: this.listSelect(),
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant as TenantListItem;
  }

  private async assertNameUnique(name: string, excludeId?: string): Promise<void> {
    const existing = await this.prisma.tenant.findFirst({
      where: { name, deletedAt: null, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`A tenant named "${name}" already exists`);
  }

  private async assertSlugUnique(slug: string): Promise<void> {
    const existing = await this.prisma.tenant.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`Slug "${slug}" is already taken`);
  }

  private async assertSubdomainUnique(subdomain: string): Promise<void> {
    const existing = await this.prisma.tenant.findFirst({
      where: { subdomain, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`Subdomain "${subdomain}" is already taken`);
  }

  private listSelect() {
    return {
      id: true,
      name: true,
      slug: true,
      domain: true,
      subdomain: true,
      status: true,
      timezone: true,
      currency: true,
      logo: true,
      ownerUserId: true,
      createdAt: true,
    } as const;
  }
}
