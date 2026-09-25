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
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ResolveCustomerPriceQueryDto } from './dto/resolve-price-query.dto';
import { ListCustomerLedgerQueryDto } from './dto/list-customer-ledger-query.dto';
import { CustomerStatementQueryDto } from './dto/customer-statement-query.dto';
import { AdjustCustomerContainersDto } from './dto/adjust-customer-containers.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @RequirePermissions('customers:read')
  list(@Query() query: ListCustomersQueryDto, @CurrentTenant() tenantId: string) {
    return this.customersService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('customers:create')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customersService.create(tenantId, dto, user.id);
  }

  @Get(':id/ledger')
  @RequirePermissions('ledger:read')
  ledger(
    @Param('id') id: string,
    @Query() query: ListCustomerLedgerQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.customersService.ledger(id, tenantId, query);
  }

  @Get(':id/balance')
  @RequirePermissions('ledger:read')
  balance(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.customersService.balance(id, tenantId);
  }

  @Get(':id/statement')
  @RequirePermissions('ledger:read')
  statement(
    @Param('id') id: string,
    @Query() query: CustomerStatementQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.customersService.statement(id, tenantId, query);
  }

  @Get(':id/container-balance')
  @RequirePermissions('customers:read')
  containerBalance(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.customersService.containerBalance(id, tenantId);
  }

  @Post(':id/container-adjustments')
  @RequirePermissions('customers:update')
  adjustContainers(
    @Param('id') id: string,
    @Body() dto: AdjustCustomerContainersDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customersService.adjustContainers(id, tenantId, dto, user.id);
  }

  @Get(':id/price')
  @RequirePermissions('customers:read')
  price(
    @Param('id') id: string,
    @Query() query: ResolveCustomerPriceQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.customersService.resolvePrice(id, tenantId, query.productId);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.customersService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions('customers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customersService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers:delete')
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customersService.softDelete(id, tenantId, user.id);
  }
}
