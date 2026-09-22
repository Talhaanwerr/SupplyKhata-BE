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
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { ListVehiclesQueryDto } from './dto/list-vehicles-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'vehicles', version: '1' })
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  @RequirePermissions('vehicles:read')
  list(@Query() query: ListVehiclesQueryDto, @CurrentTenant() tenantId: string) {
    return this.vehiclesService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('vehicles:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.vehiclesService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('vehicles:create')
  create(
    @Body() dto: CreateVehicleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehiclesService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('vehicles:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehiclesService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vehicles:delete')
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehiclesService.softDelete(id, tenantId, user.id);
  }
}
