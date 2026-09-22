import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { DeliveriesService } from './deliveries.service';
import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'deliveries', version: '1' })
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Post()
  @RequirePermissions('deliveries:create')
  create(
    @Body() dto: CreateDeliveryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliveriesService.create(tenantId, dto, user.id);
  }

  @Get()
  @RequirePermissions('deliveries:read')
  list(@Query() query: ListDeliveriesQueryDto, @CurrentTenant() tenantId: string) {
    return this.deliveriesService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('deliveries:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.deliveriesService.findOne(id, tenantId);
  }

  @Patch(':id/cancel')
  @RequirePermissions('deliveries:update')
  cancel(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliveriesService.cancel(id, tenantId, user.id);
  }
}
