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
import { AreasService } from './areas.service';
import { CreateAreaDto } from './dto/create-area.dto';
import { UpdateAreaDto } from './dto/update-area.dto';
import { ListAreasQueryDto } from './dto/list-areas-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'areas', version: '1' })
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Get()
  @RequirePermissions('areas:read')
  list(@Query() query: ListAreasQueryDto, @CurrentTenant() tenantId: string) {
    return this.areasService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('areas:create')
  create(
    @Body() dto: CreateAreaDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.areasService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('areas:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAreaDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.areasService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('areas:delete')
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.areasService.softDelete(id, tenantId, user.id);
  }
}
