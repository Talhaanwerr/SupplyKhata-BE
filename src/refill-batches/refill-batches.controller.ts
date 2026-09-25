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
import { RefillBatchesService } from './refill-batches.service';
import { CreateRefillBatchDto } from './dto/create-refill-batch.dto';
import { UpdateRefillBatchDto } from './dto/update-refill-batch.dto';
import { ListRefillBatchesQueryDto } from './dto/list-refill-batches-query.dto';
import { AvailableRefillBatchesQueryDto } from './dto/available-refill-batches-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'refill-batches', version: '1' })
export class RefillBatchesController {
  constructor(private readonly refillBatchesService: RefillBatchesService) {}

  @Get('available')
  @RequirePermissions('refill:read')
  available(@Query() query: AvailableRefillBatchesQueryDto, @CurrentTenant() tenantId: string) {
    return this.refillBatchesService.available(tenantId, query.productId);
  }

  @Get()
  @RequirePermissions('refill:read')
  list(@Query() query: ListRefillBatchesQueryDto, @CurrentTenant() tenantId: string) {
    return this.refillBatchesService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('refill:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.refillBatchesService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('refill:create')
  create(
    @Body() dto: CreateRefillBatchDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refillBatchesService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('refill:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRefillBatchDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refillBatchesService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('refill:delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.refillBatchesService.remove(id, tenantId, user.id);
  }
}
