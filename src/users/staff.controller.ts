import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { UsersService } from './users.service';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(private readonly usersService: UsersService) {}

  /** GET /staff?role=RIDER — tenant members filtered by role slug (for dropdowns / riders page). */
  @Get()
  @RequirePermissions('users:read')
  list(@Query() query: ListStaffQueryDto, @CurrentTenant() tenantId: string) {
    return this.usersService.listStaff(tenantId, query);
  }
}
