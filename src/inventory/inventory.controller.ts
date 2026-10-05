import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { InventoryService } from './inventory.service';
import { CreateStockLocationDto, UpdateStockLocationDto } from './dto/stock-location.dto';
import { PostAdjustmentDto, PostOpeningStockDto, PostTransferDto } from './dto/stock-movements.dto';
import {
  ListBalancesQueryDto,
  ListLocationsQueryDto,
  ListMovementsQueryDto,
} from './dto/list-inventory-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ─── Locations ───────────────────────────────────────────────

  @Get('locations')
  @RequirePermissions('inventory:read')
  listLocations(@Query() query: ListLocationsQueryDto, @CurrentTenant() tenantId: string) {
    return this.inventoryService.listLocations(tenantId, query);
  }

  @Post('locations')
  @RequirePermissions('inventory:create')
  createLocation(
    @Body() dto: CreateStockLocationDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.createLocation(tenantId, dto, user.id);
  }

  @Patch('locations/:id')
  @RequirePermissions('inventory:update')
  updateLocation(
    @Param('id') id: string,
    @Body() dto: UpdateStockLocationDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.updateLocation(tenantId, id, dto, user.id);
  }

  // ─── Balances ────────────────────────────────────────────────

  @Get('balances')
  @RequirePermissions('inventory:read')
  listBalances(@Query() query: ListBalancesQueryDto, @CurrentTenant() tenantId: string) {
    return this.inventoryService.listBalances(tenantId, query);
  }

  // ─── Movements ───────────────────────────────────────────────

  @Get('movements')
  @RequirePermissions('inventory:read')
  listMovements(@Query() query: ListMovementsQueryDto, @CurrentTenant() tenantId: string) {
    return this.inventoryService.listMovements(tenantId, query);
  }

  @Post('opening')
  @RequirePermissions('inventory:create')
  postOpening(
    @Body() dto: PostOpeningStockDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.postOpening(tenantId, dto, user.id);
  }

  @Post('adjustments')
  @RequirePermissions('inventory:adjust')
  postAdjustment(
    @Body() dto: PostAdjustmentDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.postAdjustment(tenantId, dto, user.id);
  }

  @Post('transfers')
  @RequirePermissions('inventory:transfer')
  postTransfer(
    @Body() dto: PostTransferDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.postTransfer(tenantId, dto, user.id);
  }
}
