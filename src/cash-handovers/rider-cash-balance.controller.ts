import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CashHandoversService } from './cash-handovers.service';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'riders', version: '1' })
export class RiderCashBalanceController {
  constructor(private readonly cashHandoversService: CashHandoversService) {}

  @Get(':riderId/cash-balance')
  @RequirePermissions('handovers:read')
  cashBalance(@Param('riderId') riderId: string, @CurrentTenant() tenantId: string) {
    return this.cashHandoversService.riderCashBalance(tenantId, riderId);
  }
}
