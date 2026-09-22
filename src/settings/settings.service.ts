import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FilesService } from '../files/files.service';
import { FileVisibility } from '../files/dto/list-files-query.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

type TenantSettings = {
  id: string;
  tenantId: string;
  orgName: string | null;
  logo: string | null;
  phone: string | null;
  address: string | null;
  timezone: string;
  currency: string;
  dateFormat: string;
  invoicePrefix: string;
  themeColor: string;
  allowedDomains: string[];
  createdAt: Date;
  updatedAt: Date;
};

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
  if (domains === undefined) return undefined;
  const cleaned = [
    ...new Set(
      domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter((d) => d.length > 0),
    ),
  ];
  return cleaned;
}

function mapSettings(row: {
  id: string;
  tenantId: string;
  orgName: string | null;
  logo: string | null;
  phone: string | null;
  address: string | null;
  timezone: string;
  currency: string;
  dateFormat: string;
  invoicePrefix: string;
  themeColor: string;
  allowedDomains: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): TenantSettings {
  const raw = row.allowedDomains;
  const allowedDomains = Array.isArray(raw)
    ? raw.filter((d): d is string => typeof d === 'string')
    : [];
  return { ...row, allowedDomains };
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly filesService: FilesService,
  ) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      update: {},
      create: { tenantId },
    });
    return mapSettings(settings);
  }

  async update(tenantId: string, dto: UpdateSettingsDto, actorId: string): Promise<TenantSettings> {
    const old = await this.get(tenantId);
    const domains = normalizeDomains(dto.allowedDomains);

    const data: Prisma.TenantSettingsUpdateInput = {};
    if (dto.orgName !== undefined) data.orgName = dto.orgName;
    if (dto.logo !== undefined) data.logo = dto.logo;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.dateFormat !== undefined) data.dateFormat = dto.dateFormat;
    if (dto.invoicePrefix !== undefined) data.invoicePrefix = dto.invoicePrefix;
    if (dto.themeColor !== undefined) data.themeColor = dto.themeColor;
    if (domains !== undefined) data.allowedDomains = domains;

    const updated = await this.prisma.tenantSettings.update({
      where: { tenantId },
      data,
    });

    // Keep Tenant row in sync for switcher / auth payloads
    const tenantPatch: {
      name?: string;
      logo?: string | null;
      timezone?: string;
      currency?: string;
    } = {};
    if (dto.orgName !== undefined) tenantPatch.name = dto.orgName;
    if (dto.logo !== undefined) tenantPatch.logo = dto.logo;
    if (dto.timezone !== undefined) tenantPatch.timezone = dto.timezone;
    if (dto.currency !== undefined) tenantPatch.currency = dto.currency;

    if (Object.keys(tenantPatch).length > 0) {
      await this.prisma.tenant.update({ where: { id: tenantId }, data: tenantPatch });
    }

    await this.audit.write({
      tenantId,
      actorId,
      module: 'settings',
      action: 'UPDATE',
      entityId: updated.id,
      oldValue: {
        orgName: old.orgName,
        logo: old.logo,
        phone: old.phone,
        address: old.address,
        timezone: old.timezone,
        currency: old.currency,
        dateFormat: old.dateFormat,
        invoicePrefix: old.invoicePrefix,
        themeColor: old.themeColor,
        allowedDomains: old.allowedDomains,
      },
      newValue: dto as unknown as Record<string, unknown>,
    });

    return mapSettings(updated);
  }

  async uploadLogo(
    file: Express.Multer.File,
    tenantId: string,
    actorId: string,
  ): Promise<TenantSettings> {
    const fileRecord = await this.filesService.upload(
      file,
      { visibility: FileVisibility.PUBLIC },
      tenantId,
      actorId,
    );
    const { url } = await this.filesService.getSignedUrl(fileRecord.id, tenantId, actorId);
    return this.update(tenantId, { logo: url }, actorId);
  }

  async clearLogo(tenantId: string, actorId: string): Promise<TenantSettings> {
    return this.update(tenantId, { logo: null }, actorId);
  }

  async deleteTenant(tenantId: string, actorId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, name: true },
    });

    if (!tenant) throw new NotFoundException('Tenant not found');

    await this.prisma.$transaction([
      this.prisma.userSession.deleteMany({ where: { tenantId } }),
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { deletedAt: new Date() },
      }),
    ]);

    await this.audit.write({
      tenantId,
      actorId,
      module: 'settings',
      action: 'DELETE',
      entityId: tenantId,
      oldValue: { name: tenant.name },
      newValue: { deletedAt: new Date().toISOString() },
    });
  }
}
