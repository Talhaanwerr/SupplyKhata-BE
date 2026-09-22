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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';

@ApiTags('Tenants')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller({ path: 'tenants', version: '1' })
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  // POST /api/v1/tenants
  @Post()
  @ApiOperation({ summary: 'Create a new tenant (super admin only)' })
  @ApiResponse({ status: 201, description: 'Tenant created' })
  @ApiResponse({ status: 409, description: 'Slug or subdomain already taken' })
  create(@Body() dto: CreateTenantDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.create(dto, user.id);
  }

  // GET /api/v1/tenants/stats
  @Get('stats')
  @ApiOperation({ summary: 'Dashboard stats: tenant counts by status + total users' })
  stats() {
    return this.tenantsService.stats();
  }

  // GET /api/v1/tenants
  @Get()
  @ApiOperation({ summary: 'List all tenants with pagination, search, and status filter' })
  findAll(@Query() query: ListTenantsQueryDto) {
    return this.tenantsService.findAll(query);
  }

  // GET /api/v1/tenants/:id
  @Get(':id')
  @ApiOperation({ summary: 'Get tenant detail by ID' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  findOne(@Param('id') id: string) {
    return this.tenantsService.findOne(id);
  }

  // PATCH /api/v1/tenants/:id
  @Patch(':id')
  @ApiOperation({ summary: 'Update tenant fields' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.update(id, dto, user.id);
  }

  // PATCH /api/v1/tenants/:id/suspend
  @Patch(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a tenant' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  suspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.suspend(id, user.id);
  }

  // PATCH /api/v1/tenants/:id/activate
  @Patch(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a tenant' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.activate(id, user.id);
  }

  // PATCH /api/v1/tenants/:id/cancel
  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a tenant' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.cancel(id, user.id);
  }

  // DELETE /api/v1/tenants/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a tenant (super admin only)' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiResponse({ status: 204, description: 'Tenant deleted' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.delete(id, user.id);
  }
}
