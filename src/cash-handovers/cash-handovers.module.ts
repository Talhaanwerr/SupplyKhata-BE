import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { CashHandoversController } from './cash-handovers.controller';
import { RiderCashBalanceController } from './rider-cash-balance.controller';
import { CashHandoversService } from './cash-handovers.service';

@Module({
  controllers: [CashHandoversController, RiderCashBalanceController],
  providers: [CashHandoversService, PermissionsGuard, TenantGuard],
  exports: [CashHandoversService],
})
export class CashHandoversModule {}
