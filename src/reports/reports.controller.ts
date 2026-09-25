import { Controller, Get, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { ReportsService } from './reports.service';
import {
  CustomerLedgerReportQueryDto,
  DailySalesQueryDto,
  DateRangeQueryDto,
  ExpensesReportQueryDto,
  MonthlySummaryQueryDto,
  ReportExportQueryDto,
  RiderCollectionQueryDto,
  VehiclePerformanceQueryDto,
  CollectionPerformanceQueryDto,
} from './dto/reports-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-sales')
  @RequirePermissions('reports:read')
  dailySales(@Query() query: DailySalesQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.dailySales(tenantId, query);
  }

  @Get('monthly-summary')
  @RequirePermissions('reports:read')
  monthlySummary(@Query() query: MonthlySummaryQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.monthlySummary(tenantId, query);
  }

  @Get('product-performance')
  @RequirePermissions('reports:read')
  productPerformance(@Query() query: DateRangeQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.productPerformance(tenantId, query);
  }

  @Get('customer-outstanding')
  @RequirePermissions('reports:read')
  customerOutstanding(@CurrentTenant() tenantId: string) {
    return this.reportsService.customerOutstanding(tenantId);
  }

  @Get('customer-ledger')
  @RequirePermissions('reports:read')
  customerLedger(@Query() query: CustomerLedgerReportQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.customerLedger(tenantId, query);
  }

  @Get('container-inventory')
  @RequirePermissions('reports:read')
  containerInventory(@CurrentTenant() tenantId: string) {
    return this.reportsService.containerInventoryReport(tenantId);
  }

  @Get('rider-collection')
  @RequirePermissions('reports:read')
  riderCollection(@Query() query: RiderCollectionQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.riderCollection(tenantId, query);
  }

  @Get('vehicle-performance')
  @RequirePermissions('reports:read')
  vehiclePerformance(
    @Query() query: VehiclePerformanceQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.reportsService.vehiclePerformance(tenantId, query);
  }

  @Get('collection-performance')
  @RequirePermissions('reports:read')
  collectionPerformance(
    @Query() query: CollectionPerformanceQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.reportsService.collectionPerformance(tenantId, query);
  }

  @Get('expenses')
  @RequirePermissions('reports:read')
  expenses(@Query() query: ExpensesReportQueryDto, @CurrentTenant() tenantId: string) {
    return this.reportsService.expensesReport(tenantId, query);
  }

  @Get('export')
  @RequirePermissions('reports:read')
  export(
    @Query() query: ReportExportQueryDto,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.reportsService.export(tenantId, query, res);
  }
}
