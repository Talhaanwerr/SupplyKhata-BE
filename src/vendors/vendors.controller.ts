import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { VendorsService } from './vendors.service';
import { CreateVendorDto, UpdateVendorDto } from './dto/vendor.dto';
import { ListVendorsQueryDto } from './dto/list-vendors-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'vendors', version: '1' })
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get()
  @RequirePermissions('vendors:read')
  list(@Query() query: ListVendorsQueryDto, @CurrentTenant() tenantId: string) {
    return this.vendorsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('vendors:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.vendorsService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('vendors:create')
  create(
    @Body() dto: CreateVendorDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorsService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('vendors:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVendorDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorsService.update(id, tenantId, dto, user.id);
  }
}
