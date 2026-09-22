import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { AssignRoleToUserDto } from './dto/assign-role-to-user.dto';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard)
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  // ─── Roles ───────────────────────────────────────────────────

  @Get()
  @RequirePermissions('roles:read')
  listRoles(
    @Query() query: ListRolesQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.listRoles(tenantId, user.isSuperAdmin, query);
  }

  @Get(':id')
  @RequirePermissions('roles:read')
  getRole(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.getRole(id, tenantId, user.isSuperAdmin);
  }

  @Post()
  @RequirePermissions('roles:create')
  createRole(
    @Body() dto: CreateRoleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.createRole(dto, tenantId, user.id);
  }

  @Patch(':id')
  @RequirePermissions('roles:update')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.updateRole(id, dto, tenantId, user.isSuperAdmin, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles:delete')
  deleteRole(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.deleteRole(id, tenantId, user.isSuperAdmin, user.id);
  }

  // ─── Permissions ─────────────────────────────────────────────

  @Get('/permissions/list')
  @RequirePermissions('permissions:read')
  listPermissions(@CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.listPermissions(user.isSuperAdmin);
  }

  @Post(':id/permissions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('roles:update')
  assignPermissions(
    @Param('id') roleId: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.assignPermissions(roleId, dto, tenantId, user.isSuperAdmin, user.id);
  }

  @Delete(':id/permissions/:permissionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles:update')
  removePermission(
    @Param('id') roleId: string,
    @Param('permissionId') permissionId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.removePermission(
      roleId,
      permissionId,
      tenantId,
      user.isSuperAdmin,
      user.id,
    );
  }

  // ─── User–Role assignment ─────────────────────────────────────

  @Get('/users/:userId/roles')
  @RequirePermissions('roles:read')
  getUserRoles(
    @Param('userId') userId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.getUserRoles(userId, tenantId, user.isSuperAdmin);
  }

  @Post('/users/:userId/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('roles:update')
  @Roles('tenant_owner', 'tenant_admin', 'super_admin')
  assignRoleToUser(
    @Param('userId') userId: string,
    @Body() dto: AssignRoleToUserDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.assignRoleToUser(userId, dto, user.id, tenantId, user.isSuperAdmin);
  }

  @Delete('/users/:userId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles:update')
  @Roles('tenant_owner', 'tenant_admin', 'super_admin')
  removeRoleFromUser(
    @Param('userId') userId: string,
    @Param('roleId') roleId: string,
    @Query('tenantId') targetTenantId: string | undefined,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rolesService.removeRoleFromUser(
      userId,
      roleId,
      user.id,
      tenantId,
      user.isSuperAdmin,
      targetTenantId,
    );
  }
}
