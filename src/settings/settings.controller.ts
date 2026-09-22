import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { SettingsService } from './settings.service';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /** GET /api/v1/settings/platform — Super Admin platform prefs */
  @Get('platform')
  @UseGuards(SuperAdminGuard)
  getPlatform() {
    return this.platformSettings.get();
  }

  /** PATCH /api/v1/settings/platform — Super Admin platform prefs */
  @Patch('platform')
  @UseGuards(SuperAdminGuard)
  updatePlatform(@Body() dto: UpdatePlatformSettingsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.platformSettings.update(dto, user.id);
  }

  @Get()
  @RequirePermissions('settings:read')
  get(@CurrentTenant() tenantId: string) {
    return this.settingsService.get(tenantId);
  }

  @Post('logo')
  @RequirePermissions('settings:update')
  @UseInterceptors(FileInterceptor('logo', { storage: memoryStorage() }))
  uploadLogo(
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_LOGO_BYTES }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
        exceptionFactory: (error: string) => {
          if (/expected type|file type/i.test(error)) {
            return new BadRequestException('Please upload a JPEG, PNG, or WebP image.');
          }
          if (/larger than|maxFileSize|expected size/i.test(error)) {
            return new BadRequestException('Image must be 2 MB or smaller.');
          }
          return new BadRequestException(error || 'Invalid logo file.');
        },
      }),
    )
    file: Express.Multer.File,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settingsService.uploadLogo(file, tenantId, user.id);
  }

  @Delete('logo')
  @RequirePermissions('settings:update')
  clearLogo(@CurrentTenant() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.settingsService.clearLogo(tenantId, user.id);
  }

  @Patch()
  @RequirePermissions('settings:update')
  update(
    @Body() dto: UpdateSettingsDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settingsService.update(tenantId, dto, user.id);
  }

  @Delete('tenant')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('settings:manage')
  async deleteTenant(@CurrentTenant() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.settingsService.deleteTenant(tenantId, user.id);
  }
}
