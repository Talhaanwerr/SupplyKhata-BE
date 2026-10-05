import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ProductionService } from './production.service';
import {
  CancelProductionOrderDto,
  CompleteProductionOrderDto,
  CreateProductionOrderDto,
  ListProductionOrdersQueryDto,
  UpdateProductionOrderDto,
} from './dto/production-order.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'production-orders', version: '1' })
export class ProductionController {
  constructor(private readonly productionService: ProductionService) {}

  @Get()
  @RequirePermissions('production:read')
  list(@Query() query: ListProductionOrdersQueryDto, @CurrentTenant() tenantId: string) {
    return this.productionService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('production:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productionService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('production:create')
  create(
    @Body() dto: CreateProductionOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('production:create')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductionOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.update(id, tenantId, dto, user.id);
  }

  @Post(':id/plan')
  @RequirePermissions('production:create')
  plan(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.plan(id, tenantId, user.id);
  }

  @Post(':id/start')
  @RequirePermissions('production:start')
  start(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.start(id, tenantId, user.id);
  }

  @Post(':id/complete')
  @RequirePermissions('production:complete')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteProductionOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.complete(id, tenantId, dto, user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('production:cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelProductionOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productionService.cancel(id, tenantId, dto, user.id);
  }
}
