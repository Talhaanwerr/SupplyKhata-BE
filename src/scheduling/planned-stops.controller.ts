import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { SchedulingService } from './scheduling.service';
import {
  CreateManualPlannedStopDto,
  ListPlannedStopsQueryDto,
  SkipFailPlannedStopDto,
  UpdatePlannedStopDto,
} from './dto/planned-stops.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'planned-stops', version: '1' })
export class PlannedStopsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get()
  @RequirePermissions('planned-stops:read')
  list(@Query() query: ListPlannedStopsQueryDto, @CurrentTenant() tenantId: string) {
    return this.scheduling.listPlannedStops(tenantId, query);
  }

  @Post()
  @RequirePermissions('planned-stops:create')
  create(
    @Body() dto: CreateManualPlannedStopDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scheduling.createManualStop(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('planned-stops:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlannedStopDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scheduling.updatePlannedStop(id, tenantId, dto, user.id);
  }

  @Post(':id/skip')
  @RequirePermissions('planned-stops:update')
  skip(
    @Param('id') id: string,
    @Body() dto: SkipFailPlannedStopDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scheduling.skipStop(id, tenantId, dto, user.id);
  }

  @Post(':id/fail')
  @RequirePermissions('planned-stops:update')
  fail(
    @Param('id') id: string,
    @Body() dto: SkipFailPlannedStopDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scheduling.failStop(id, tenantId, dto, user.id);
  }
}
