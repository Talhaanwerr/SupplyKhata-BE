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
import { CashHandoversService } from './cash-handovers.service';
import { CreateCashHandoverDto } from './dto/create-cash-handover.dto';
import { UpdateCashHandoverDto } from './dto/update-cash-handover.dto';
import { ListCashHandoversQueryDto } from './dto/list-cash-handovers-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'cash-handovers', version: '1' })
export class CashHandoversController {
  constructor(private readonly cashHandoversService: CashHandoversService) {}

  @Get()
  @RequirePermissions('handovers:read')
  list(@Query() query: ListCashHandoversQueryDto, @CurrentTenant() tenantId: string) {
    return this.cashHandoversService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('handovers:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.cashHandoversService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('handovers:create')
  create(
    @Body() dto: CreateCashHandoverDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cashHandoversService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('handovers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCashHandoverDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cashHandoversService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('handovers:delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.cashHandoversService.remove(id, tenantId, user.id);
  }
}
