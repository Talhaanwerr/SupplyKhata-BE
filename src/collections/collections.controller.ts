import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CollectionsService } from './collections.service';
import { CollectionsListQueryDto } from './dto/collections-list-query.dto';
import { RecordCollectionVisitDto } from './dto/record-collection-visit.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'collections', version: '1' })
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get('list')
  @RequirePermissions('collections:read')
  list(
    @Query() query: CollectionsListQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.list(tenantId, query, user.id);
  }

  @Post(':customerId/visit')
  @RequirePermissions('collections:create')
  recordVisit(
    @Param('customerId') customerId: string,
    @Body() dto: RecordCollectionVisitDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.recordVisit(tenantId, customerId, dto, user.id);
  }
}
