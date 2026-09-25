import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PaymentsModule } from '../payments/payments.module';
import { CashHandoversModule } from '../cash-handovers/cash-handovers.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [PaymentsModule, CashHandoversModule],
  controllers: [DashboardController],
  providers: [DashboardService, PermissionsGuard, TenantGuard],
  exports: [DashboardService],
})
export class DashboardModule {}
