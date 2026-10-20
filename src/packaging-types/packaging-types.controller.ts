import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PackagingTypesService } from './packaging-types.service';
import { CreatePackagingTypeDto } from './dto/create-packaging-type.dto';
import { UpdatePackagingTypeDto } from './dto/update-packaging-type.dto';
import { ListPackagingTypesQueryDto } from './dto/list-packaging-types-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'packaging-types', version: '1' })
export class PackagingTypesController {
  constructor(private readonly packagingTypesService: PackagingTypesService) {}

  @Get()
  @RequirePermissions('containers:read')
  list(@Query() query: ListPackagingTypesQueryDto, @CurrentTenant() tenantId: string) {
    return this.packagingTypesService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('containers:update')
  create(
    @Body() dto: CreatePackagingTypeDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packagingTypesService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('containers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackagingTypeDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packagingTypesService.update(id, tenantId, dto, user.id);
  }
}
