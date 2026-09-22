import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { DeliveryRunsService } from './delivery-runs.service';
import { CreateDeliveryRunDto } from './dto/create-delivery-run.dto';
import { CloseDeliveryRunDto } from './dto/close-delivery-run.dto';
import { UpdateDeliveryRunDto } from './dto/update-delivery-run.dto';
import { ListDeliveryRunsQueryDto } from './dto/list-delivery-runs-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'delivery-runs', version: '1' })
export class DeliveryRunsController {
  constructor(private readonly deliveryRunsService: DeliveryRunsService) {}

  @Post()
  @RequirePermissions('deliveryruns:create')
  create(
    @Body() dto: CreateDeliveryRunDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliveryRunsService.create(tenantId, dto, user.id);
  }

  @Get()
  @RequirePermissions('deliveryruns:read')
  list(@Query() query: ListDeliveryRunsQueryDto, @CurrentTenant() tenantId: string) {
    return this.deliveryRunsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('deliveryruns:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.deliveryRunsService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions('deliveryruns:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryRunDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliveryRunsService.update(id, tenantId, dto, user.id);
  }

  @Patch(':id/close')
  @RequirePermissions('deliveryruns:update')
  close(
    @Param('id') id: string,
    @Body() dto: CloseDeliveryRunDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliveryRunsService.close(id, tenantId, dto, user.id);
  }

  @Get(':id/summary')
  @RequirePermissions('deliveryruns:read')
  summary(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.deliveryRunsService.summary(id, tenantId);
  }
}
