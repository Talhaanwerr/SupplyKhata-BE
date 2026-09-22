import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export type PlatformSettingsDto = {
  id: string;
  appName: string;
  supportEmail: string;
  defaultTimezone: string;
  defaultCurrency: string;
  updatedAt: Date;
};

export type UpdatePlatformSettingsDto = {
  appName?: string;
  supportEmail?: string;
  defaultTimezone?: string;
  defaultCurrency?: string;
};

@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async get(): Promise<PlatformSettingsDto> {
    const row = await this.prisma.platformSettings.upsert({
      where: { id: 'platform' },
      update: {},
      create: { id: 'platform' },
    });
    return row;
  }

  async update(dto: UpdatePlatformSettingsDto, actorId: string): Promise<PlatformSettingsDto> {
    const old = await this.get();
    const updated = await this.prisma.platformSettings.update({
      where: { id: 'platform' },
      data: {
        ...(dto.appName !== undefined ? { appName: dto.appName.trim() } : {}),
        ...(dto.supportEmail !== undefined ? { supportEmail: dto.supportEmail.trim() } : {}),
        ...(dto.defaultTimezone !== undefined ? { defaultTimezone: dto.defaultTimezone } : {}),
        ...(dto.defaultCurrency !== undefined
          ? { defaultCurrency: dto.defaultCurrency.toUpperCase() }
          : {}),
      },
    });

    await this.audit.write({
      tenantId: null,
      actorId,
      module: 'platform-settings',
      action: 'UPDATE',
      entityId: 'platform',
      oldValue: old as unknown as Record<string, unknown>,
      newValue: dto as unknown as Record<string, unknown>,
    });

    return updated;
  }
}
