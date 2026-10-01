import { Controller, Get, Post, Patch, Put, Body, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { ReplaceOrderItemsDto } from './dto/replace-order-items.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { RecordOrderPaymentDto } from './dto/record-order-payment.dto';
import { RefundOrderDto } from './dto/refund-order.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermissions('orders:read')
  list(@Query() query: ListOrdersQueryDto, @CurrentTenant() tenantId: string) {
    return this.ordersService.list(tenantId, query);
  }

  @Get(':id/timeline')
  @RequirePermissions('orders:read')
  timeline(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.ordersService.timeline(id, tenantId);
  }

  @Get(':id')
  @RequirePermissions('orders:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.ordersService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('orders:create')
  create(
    @Body() dto: CreateOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('orders:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.update(id, tenantId, dto, user.id);
  }

  @Put(':id/items')
  @RequirePermissions('orders:update')
  replaceItems(
    @Param('id') id: string,
    @Body() dto: ReplaceOrderItemsDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.replaceItems(id, tenantId, dto, user.id);
  }

  @Post(':id/place')
  @RequirePermissions('orders:update')
  place(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.place(id, tenantId, user.id);
  }

  @Post(':id/ship')
  @RequirePermissions('orders:update')
  ship(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.ship(id, tenantId, user.id);
  }

  @Post(':id/deliver')
  @RequirePermissions('orders:update')
  deliver(
    @Param('id') id: string,
    @Body() dto: DeliverOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.deliver(id, tenantId, dto, user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('orders:cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.cancel(id, tenantId, dto, user.id);
  }

  @Post(':id/payments')
  @RequirePermissions('orders:update')
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordOrderPaymentDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.recordPayment(id, tenantId, dto, user.id);
  }

  @Post(':id/refund')
  @RequirePermissions('orders:refund')
  refund(
    @Param('id') id: string,
    @Body() dto: RefundOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.refund(id, tenantId, dto, user.id);
  }
}
