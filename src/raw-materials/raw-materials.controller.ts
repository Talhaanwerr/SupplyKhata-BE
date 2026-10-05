import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { RawMaterialsService } from './raw-materials.service';
import { CreateRawMaterialDto, UpdateRawMaterialDto } from './dto/raw-material.dto';
import { CreateRawMaterialCostDto } from './dto/raw-material-cost.dto';
import {
  ListRawBalancesQueryDto,
  ListRawMaterialsQueryDto,
  ListRawMovementsQueryDto,
} from './dto/list-raw-materials-query.dto';
import { PostRawAdjustmentDto, PostRawOpeningDto } from './dto/raw-stock-movements.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'raw-materials', version: '1' })
export class RawMaterialsController {
  constructor(private readonly rawMaterialsService: RawMaterialsService) {}

  @Get()
  @RequirePermissions('raw-materials:read')
  list(@Query() query: ListRawMaterialsQueryDto, @CurrentTenant() tenantId: string) {
    return this.rawMaterialsService.list(tenantId, query);
  }

  @Get('balances')
  @RequirePermissions('raw-materials:read')
  listBalances(@Query() query: ListRawBalancesQueryDto, @CurrentTenant() tenantId: string) {
    return this.rawMaterialsService.listBalances(tenantId, query);
  }

  @Get('movements')
  @RequirePermissions('raw-materials:read')
  listMovements(@Query() query: ListRawMovementsQueryDto, @CurrentTenant() tenantId: string) {
    return this.rawMaterialsService.listMovements(tenantId, query);
  }

  @Post('opening')
  @RequirePermissions('raw-materials:create')
  postOpening(
    @Body() dto: PostRawOpeningDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rawMaterialsService.postOpening(tenantId, dto, user.id);
  }

  @Post('adjustments')
  @RequirePermissions('raw-materials:adjust')
  postAdjustment(
    @Body() dto: PostRawAdjustmentDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rawMaterialsService.postAdjustment(tenantId, dto, user.id);
  }

  @Get(':id/costs')
  @RequirePermissions('raw-materials:read')
  listCosts(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.rawMaterialsService.listCosts(id, tenantId);
  }

  @Post(':id/costs')
  @RequirePermissions('raw-materials:update')
  addCost(
    @Param('id') id: string,
    @Body() dto: CreateRawMaterialCostDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rawMaterialsService.addCost(id, tenantId, dto, user.id);
  }

  @Get(':id')
  @RequirePermissions('raw-materials:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.rawMaterialsService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('raw-materials:create')
  create(
    @Body() dto: CreateRawMaterialDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rawMaterialsService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('raw-materials:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRawMaterialDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rawMaterialsService.update(id, tenantId, dto, user.id);
  }
}
