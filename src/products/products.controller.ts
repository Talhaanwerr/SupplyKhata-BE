import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { CreateProductCostDto } from './dto/create-product-cost.dto';
import { CurrentCostQueryDto } from './dto/current-cost-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions('products:read')
  list(@Query() query: ListProductsQueryDto, @CurrentTenant() tenantId: string) {
    return this.productsService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('products:create')
  create(
    @Body() dto: CreateProductDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.create(tenantId, dto, user.id);
  }

  @Get(':id/costs')
  @RequirePermissions('products:read')
  listCosts(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.listCosts(id, tenantId);
  }

  @Post(':id/costs')
  @RequirePermissions('products:update')
  addCost(
    @Param('id') id: string,
    @Body() dto: CreateProductCostDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.addCost(id, tenantId, dto, user.id);
  }

  @Get(':id/current-cost')
  @RequirePermissions('products:read')
  currentCost(
    @Param('id') id: string,
    @Query() query: CurrentCostQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.productsService.currentCost(id, tenantId, query.date);
  }

  @Get(':id')
  @RequirePermissions('products:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions('products:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('products:delete')
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.softDelete(id, tenantId, user.id);
  }
}
