import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { VendorBillsService } from './vendor-bills.service';
import {
  CreateBillFromGoodsReceiptDto,
  CreateVendorBillDto,
  ListVendorBillsQueryDto,
  ListVendorDuesQueryDto,
  ListVendorLedgerQueryDto,
  PayVendorBillDto,
  UpdateVendorBillDueDateDto,
  VoidVendorBillDto,
} from './dto/vendor-bill.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'vendor-bills', version: '1' })
export class VendorBillsController {
  constructor(private readonly vendorBillsService: VendorBillsService) {}

  @Get()
  @RequirePermissions('vendor-bills:read')
  list(@Query() query: ListVendorBillsQueryDto, @CurrentTenant() tenantId: string) {
    return this.vendorBillsService.list(tenantId, query);
  }

  @Get('dues')
  @RequirePermissions('vendor-bills:read')
  listDues(@Query() query: ListVendorDuesQueryDto, @CurrentTenant() tenantId: string) {
    return this.vendorBillsService.listDues(tenantId, query);
  }

  @Get('ledger/:vendorId')
  @RequirePermissions('vendor-bills:read')
  listLedger(
    @Param('vendorId') vendorId: string,
    @Query() query: ListVendorLedgerQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.vendorBillsService.listLedger(tenantId, vendorId, query);
  }

  @Post()
  @RequirePermissions('vendor-bills:create')
  create(
    @Body() dto: CreateVendorBillDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorBillsService.create(tenantId, dto, user.id);
  }

  @Post('from-goods-receipt/:goodsReceiptId')
  @RequirePermissions('vendor-bills:create')
  createFromGoodsReceipt(
    @Param('goodsReceiptId') goodsReceiptId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBillFromGoodsReceiptDto = {},
  ) {
    return this.vendorBillsService.createFromGoodsReceipt(tenantId, goodsReceiptId, user.id, {
      dueDate: dto.dueDate,
    });
  }

  @Patch(':id/due-date')
  @RequirePermissions('vendor-bills:update')
  setDueDate(
    @Param('id') id: string,
    @Body() dto: UpdateVendorBillDueDateDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorBillsService.setDueDate(id, tenantId, dto.dueDate, user.id);
  }

  @Post(':id/pay')
  @RequirePermissions('vendor-bills:pay')
  pay(
    @Param('id') id: string,
    @Body() dto: PayVendorBillDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorBillsService.pay(id, tenantId, dto, user.id);
  }

  @Post(':id/void')
  @RequirePermissions('vendor-bills:create')
  voidBill(
    @Param('id') id: string,
    @Body() dto: VoidVendorBillDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vendorBillsService.void(id, tenantId, dto, user.id);
  }

  @Get(':id')
  @RequirePermissions('vendor-bills:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.vendorBillsService.findOne(id, tenantId);
  }
}
