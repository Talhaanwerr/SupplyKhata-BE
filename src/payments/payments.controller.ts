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
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('dashboard')
  @RequirePermissions('payments:read')
  dashboard(@CurrentTenant() tenantId: string) {
    return this.paymentsService.dashboard(tenantId);
  }

  @Get()
  @RequirePermissions('payments:read')
  list(@Query() query: ListPaymentsQueryDto, @CurrentTenant() tenantId: string) {
    return this.paymentsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.paymentsService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('payments:create')
  create(
    @Body() dto: CreatePaymentDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('payments:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('payments:delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.paymentsService.remove(id, tenantId, user.id);
  }
}
