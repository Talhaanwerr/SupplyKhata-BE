import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { BomService } from './bom.service';
import { CreateBomDto, ListBomsQueryDto, UpdateBomDto } from './dto/bom.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'boms', version: '1' })
export class BomController {
  constructor(private readonly bomService: BomService) {}

  @Get()
  @RequirePermissions('bom:read')
  list(@Query() query: ListBomsQueryDto, @CurrentTenant() tenantId: string) {
    return this.bomService.list(tenantId, query);
  }

  @Get('by-product/:productId/active')
  @RequirePermissions('bom:read')
  findActiveForProduct(@Param('productId') productId: string, @CurrentTenant() tenantId: string) {
    return this.bomService.findActiveForProduct(productId, tenantId);
  }

  @Get(':id')
  @RequirePermissions('bom:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.bomService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('bom:create')
  create(
    @Body() dto: CreateBomDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bomService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('bom:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBomDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bomService.update(id, tenantId, dto, user.id);
  }

  @Post(':id/deactivate')
  @RequirePermissions('bom:update')
  deactivate(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bomService.deactivate(id, tenantId, user.id);
  }
}
