import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { SchedulingService } from './scheduling.service';
import { UpsertDeliveryScheduleDto } from './dto/upsert-delivery-schedule.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'customers', version: '1' })
export class DeliverySchedulesController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get(':id/delivery-schedule')
  @RequirePermissions('schedules:read')
  get(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.scheduling.getSchedule(id, tenantId);
  }

  @Put(':id/delivery-schedule')
  @RequirePermissions('schedules:update')
  upsert(
    @Param('id') id: string,
    @Body() dto: UpsertDeliveryScheduleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scheduling.upsertSchedule(id, tenantId, dto, user.id);
  }

  @Get(':id/delivery-context')
  @RequirePermissions('customers:read')
  deliveryContext(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.scheduling.getDeliveryContext(id, tenantId);
  }
}
