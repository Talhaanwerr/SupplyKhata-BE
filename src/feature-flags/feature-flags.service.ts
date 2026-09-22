import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';

type FeatureFlagItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isGlobal: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type TenantFeatureItem = FeatureFlagItem & {
  tenantEnabled: boolean | null;
  effectivelyEnabled: boolean;
};

type FeatureFlagWithTenantOverride = FeatureFlagItem & {
  tenantFeatures: { isEnabled: boolean }[];
};

@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  // ─── Super admin: global CRUD ──────────────────────────────────────────

  async create(dto: CreateFeatureFlagDto, actorId: string): Promise<FeatureFlagItem> {
    const existing = await this.prisma.featureFlag.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) throw new ConflictException(`Feature flag slug '${dto.slug}' already exists`);

    const flag = await this.prisma.featureFlag.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        isGlobal: dto.isGlobal ?? false,
        isActive: dto.isActive ?? true,
      },
    });

    await this.audit.write({
      actorId,
      module: 'feature-flags',
      action: 'CREATE',
      entityId: flag.id,
      newValue: { slug: flag.slug, isGlobal: flag.isGlobal },
    });

    return flag as FeatureFlagItem;
  }

  async update(slug: string, dto: UpdateFeatureFlagDto, actorId: string): Promise<FeatureFlagItem> {
    const flag = await this.findFlagBySlugOrThrow(slug);

    const updated = await this.prisma.featureFlag.update({
      where: { id: flag.id },
      data: dto,
    });

    await this.audit.write({
      actorId,
      module: 'feature-flags',
      action: 'UPDATE',
      entityId: flag.id,
      oldValue: { name: flag.name, isGlobal: flag.isGlobal, isActive: flag.isActive },
      newValue: dto,
    });

    return updated as FeatureFlagItem;
  }

  // ─── List ──────────────────────────────────────────────────────────────

  /**
   * Super admin: returns all flags with each flag's raw fields.
   * Tenant user: returns only active flags, enriched with tenant-specific enabled state.
   */
  async list(tenantId: string, isSuperAdmin: boolean): Promise<unknown[]> {
    if (isSuperAdmin) {
      const flags = await this.prisma.featureFlag.findMany({
        orderBy: { name: 'asc' },
      });
      return flags;
    }

    // For tenant users — return all active flags + their per-tenant override
    const flags = (await this.prisma.featureFlag.findMany({
      where: { isActive: true },
      include: {
        tenantFeatures: {
          where: { tenantId },
          select: { isEnabled: true },
        },
      },
      orderBy: { name: 'asc' },
    })) as FeatureFlagWithTenantOverride[];

    return flags.map((f: FeatureFlagWithTenantOverride) => {
      const tenantOverride = f.tenantFeatures[0]?.isEnabled ?? null;
      return {
        id: f.id,
        name: f.name,
        slug: f.slug,
        description: f.description,
        isGlobal: f.isGlobal,
        isActive: f.isActive,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        // tenantEnabled: null = no override; uses isGlobal as default
        tenantEnabled: tenantOverride,
        effectivelyEnabled: tenantOverride !== null ? tenantOverride : f.isGlobal,
      } satisfies TenantFeatureItem;
    });
  }

  // ─── Tenant: enable / disable (disabled — SA manages overrides only) ───

  async enable(_slug: string, _tenantId: string, _actorId: string): Promise<void> {
    throw new ForbiddenException(
      'Tenants cannot toggle feature flags. Ask a Super Admin to enable this feature for your workspace.',
    );
  }

  async disable(_slug: string, _tenantId: string, _actorId: string): Promise<void> {
    throw new ForbiddenException(
      'Tenants cannot toggle feature flags. Ask a Super Admin to change this for your workspace.',
    );
  }

  // ─── Super admin: per-tenant overrides ────────────────────────────────────

  /**
   * Returns all active flags enriched with a specific tenant's current override
   * state. Used by the super admin per-tenant management UI.
   */
  async listForTenant(tenantId: string): Promise<TenantFeatureItem[]> {
    const flags = (await this.prisma.featureFlag.findMany({
      where: { isActive: true },
      include: {
        tenantFeatures: {
          where: { tenantId },
          select: { isEnabled: true },
        },
      },
      orderBy: { name: 'asc' },
    })) as FeatureFlagWithTenantOverride[];

    return flags.map((f) => {
      const override = f.tenantFeatures[0]?.isEnabled ?? null;
      return {
        id: f.id,
        name: f.name,
        slug: f.slug,
        description: f.description,
        isGlobal: f.isGlobal,
        isActive: f.isActive,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        tenantEnabled: override,
        effectivelyEnabled: override !== null ? override : f.isGlobal,
      } satisfies TenantFeatureItem;
    });
  }

  /**
   * Super admin forces a per-tenant flag override.
   * Pass `isEnabled = null` to remove the override and revert to global default.
   */
  async adminSetForTenant(
    slug: string,
    tenantId: string,
    isEnabled: boolean,
    actorId: string,
  ): Promise<void> {
    const flag = await this.findFlagBySlugOrThrow(slug);

    await this.prisma.tenantFeature.upsert({
      where: { tenantId_featureFlagId: { tenantId, featureFlagId: flag.id } },
      update: { isEnabled },
      create: { tenantId, featureFlagId: flag.id, isEnabled },
    });

    await this.audit.write({
      actorId,
      tenantId,
      module: 'feature-flags',
      action: isEnabled ? 'ADMIN_ENABLE' : 'ADMIN_DISABLE',
      entityId: flag.id,
      newValue: { slug, tenantId, isEnabled, flagName: flag.name },
    });
  }

  /**
   * Super admin removes a per-tenant override, restoring the global default.
   */
  async adminResetForTenant(slug: string, tenantId: string, actorId: string): Promise<void> {
    const flag = await this.findFlagBySlugOrThrow(slug);

    await this.prisma.tenantFeature.deleteMany({
      where: { tenantId, featureFlagId: flag.id },
    });

    await this.audit.write({
      actorId,
      tenantId,
      module: 'feature-flags',
      action: 'ADMIN_RESET',
      entityId: flag.id,
      newValue: { slug, tenantId, reset: true, flagName: flag.name },
    });
  }

  // ─── Feature access check ──────────────────────────────────────────────

  /**
   * Returns true if the tenant has access to a feature.
   * Priority: tenantFeature.isEnabled > featureFlag.isGlobal
   */
  async checkAccess(slug: string, tenantId: string): Promise<{ slug: string; enabled: boolean }> {
    const flag = await this.prisma.featureFlag.findUnique({
      where: { slug },
      include: {
        tenantFeatures: {
          where: { tenantId },
          select: { isEnabled: true },
        },
      },
    });

    if (!flag || !flag.isActive) return { slug, enabled: false };

    const tenantOverride = flag.tenantFeatures[0]?.isEnabled ?? null;
    const enabled = tenantOverride !== null ? tenantOverride : flag.isGlobal;

    return { slug, enabled };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async findFlagBySlugOrThrow(slug: string): Promise<FeatureFlagItem> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { slug } });
    if (!flag) throw new NotFoundException(`Feature flag '${slug}' not found`);
    return flag as FeatureFlagItem;
  }
}
