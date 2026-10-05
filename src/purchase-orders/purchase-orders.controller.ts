import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PurchaseOrdersService } from './purchase-orders.service';
import { GoodsReceiptsService } from './goods-receipts.service';
import {
  CancelPurchaseOrderDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';
import { CreateGoodsReceiptDto, ListGoodsReceiptsQueryDto } from './dto/goods-receipt.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'purchase-orders', version: '1' })
export class PurchaseOrdersController {
  constructor(
    private readonly purchaseOrdersService: PurchaseOrdersService,
    private readonly goodsReceiptsService: GoodsReceiptsService,
  ) {}

  @Get()
  @RequirePermissions('purchase-orders:read')
  list(@Query() query: ListPurchaseOrdersQueryDto, @CurrentTenant() tenantId: string) {
    return this.purchaseOrdersService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('purchase-orders:create')
  create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseOrdersService.create(tenantId, dto, user.id);
  }

  @Post(':id/send')
  @RequirePermissions('purchase-orders:update')
  send(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseOrdersService.send(id, tenantId, user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('purchase-orders:cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseOrdersService.cancel(id, tenantId, dto, user.id);
  }

  @Post(':id/receipts')
  @RequirePermissions('grn:create')
  createReceipt(
    @Param('id') id: string,
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.goodsReceiptsService.createForPo(id, tenantId, dto, user.id);
  }

  @Get(':id/receipts')
  @RequirePermissions('grn:read')
  listReceiptsForPo(
    @Param('id') id: string,
    @Query() query: ListGoodsReceiptsQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.goodsReceiptsService.list(tenantId, {
      ...query,
      purchaseOrderId: id,
    });
  }

  @Get(':id')
  @RequirePermissions('purchase-orders:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.purchaseOrdersService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions('purchase-orders:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseOrdersService.update(id, tenantId, dto, user.id);
  }
}

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'goods-receipts', version: '1' })
export class GoodsReceiptsController {
  constructor(private readonly goodsReceiptsService: GoodsReceiptsService) {}

  @Get()
  @RequirePermissions('grn:read')
  list(@Query() query: ListGoodsReceiptsQueryDto, @CurrentTenant() tenantId: string) {
    return this.goodsReceiptsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('grn:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.goodsReceiptsService.findOne(id, tenantId);
  }
}
