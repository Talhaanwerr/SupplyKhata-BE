import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { PlatformSettingsService } from './platform-settings.service';
import { SettingsController } from './settings.controller';
import { FilesModule } from '../files/files.module';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';

@Module({
  imports: [FilesModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    PlatformSettingsService,
    PermissionsGuard,
    TenantGuard,
    SuperAdminGuard,
  ],
  exports: [SettingsService, PlatformSettingsService],
})
export class SettingsModule {}
