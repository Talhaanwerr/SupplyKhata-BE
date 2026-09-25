import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ContainerInventoryService } from './container-inventory.service';
import { SetContainerOpeningDto } from './dto/set-container-opening.dto';
import { AdjustOwnedContainersDto } from './dto/adjust-owned-containers.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'container-inventory', version: '1' })
export class ContainerInventoryController {
  constructor(private readonly containerInventoryService: ContainerInventoryService) {}

  @Get()
  @RequirePermissions('containers:read')
  inventory(@CurrentTenant() tenantId: string) {
    return this.containerInventoryService.inventory(tenantId);
  }

  @Put('opening')
  @RequirePermissions('containers:update')
  setOpening(
    @Body() dto: SetContainerOpeningDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.containerInventoryService.setOpening(tenantId, dto, user.id);
  }

  @Post('adjustments')
  @RequirePermissions('containers:update')
  adjust(
    @Body() dto: AdjustOwnedContainersDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.containerInventoryService.adjustOwned(tenantId, dto, user.id);
  }
}
