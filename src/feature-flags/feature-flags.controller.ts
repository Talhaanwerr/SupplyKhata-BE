import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { FeatureFlagsService } from './feature-flags.service';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'feature-flags', version: '1' })
export class FeatureFlagsController {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}

  /**
   * GET /feature-flags
   * Super admin: all flags. Tenant user: active flags + their override state.
   */
  @Get()
  @RequirePermissions('feature-flags:read')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.featureFlagsService.list(user.tenantId ?? '', user.isSuperAdmin);
  }

  // ─── Super admin: per-tenant management (static paths BEFORE :slug) ─────

  @Get('admin/tenants/:tenantId')
  @UseGuards(SuperAdminGuard)
  @RequirePermissions('feature-flags:read')
  listForTenant(@Param('tenantId') tenantId: string) {
    return this.featureFlagsService.listForTenant(tenantId);
  }

  @Post('admin/tenants/:tenantId/:slug/enable')
  @UseGuards(SuperAdminGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('feature-flags:update')
  adminEnable(
    @Param('tenantId') tenantId: string,
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.adminSetForTenant(slug, tenantId, true, user.id);
  }

  @Post('admin/tenants/:tenantId/:slug/disable')
  @UseGuards(SuperAdminGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('feature-flags:update')
  adminDisable(
    @Param('tenantId') tenantId: string,
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.adminSetForTenant(slug, tenantId, false, user.id);
  }

  @Delete('admin/tenants/:tenantId/:slug/override')
  @UseGuards(SuperAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('feature-flags:update')
  adminReset(
    @Param('tenantId') tenantId: string,
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.adminResetForTenant(slug, tenantId, user.id);
  }

  @Get(':slug/access')
  @RequirePermissions('feature-flags:read')
  checkAccess(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser) {
    return this.featureFlagsService.checkAccess(slug, user.tenantId ?? '');
  }

  /** Kept for seed/tooling — prefer seeding flags, not SA UI create. */
  @Post()
  @UseGuards(SuperAdminGuard)
  @RequirePermissions('feature-flags:create')
  create(@Body() dto: CreateFeatureFlagDto, @CurrentUser() user: AuthenticatedUser) {
    return this.featureFlagsService.create(dto, user.id);
  }

  @Patch(':slug')
  @UseGuards(SuperAdminGuard)
  @RequirePermissions('feature-flags:update')
  update(
    @Param('slug') slug: string,
    @Body() dto: UpdateFeatureFlagDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.update(slug, dto, user.id);
  }

  /** Tenant self-toggle — rejected in service; only SA may change overrides. */
  @Post(':slug/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('feature-flags:update')
  enable(
    @Param('slug') slug: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.enable(slug, tenantId, user.id);
  }

  @Post(':slug/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('feature-flags:update')
  disable(
    @Param('slug') slug: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.featureFlagsService.disable(slug, tenantId, user.id);
  }
}
