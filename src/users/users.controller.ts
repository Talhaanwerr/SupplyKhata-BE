import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { UsersService } from './users.service';
import { FilesService } from '../files/files.service';
import { FileVisibility } from '../files/dto/list-files-query.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { AssignUserRolesDto } from './dto/assign-user-roles.dto';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
  ) {}

  /**
   * POST /users/me/avatar
   * Upload or replace the calling user's profile picture.
   * Accepts multipart/form-data with a single 'avatar' file field (JPEG / PNG / WebP, max 2 MB).
   * Returns the updated user record with the new avatarUrl.
   */
  @Post('me/avatar')
  @RequirePermissions('files:create')
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  async uploadAvatar(
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_AVATAR_BYTES }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
        exceptionFactory: (error: string) => {
          if (/expected type|file type/i.test(error)) {
            return new BadRequestException('Please upload a JPEG, PNG, or WebP image.');
          }
          if (/larger than|maxFileSize|expected size/i.test(error)) {
            return new BadRequestException('Image must be 2 MB or smaller.');
          }
          return new BadRequestException(error || 'Invalid avatar file.');
        },
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenantId: string,
  ) {
    const fileRecord = await this.filesService.upload(
      file,
      { visibility: FileVisibility.PUBLIC },
      tenantId,
      user.id,
    );

    const { url } = await this.filesService.getSignedUrl(fileRecord.id, tenantId, user.id);

    return this.usersService.update(user.id, { avatarUrl: url }, tenantId, user.id);
  }

  /** DELETE /users/me/avatar — clear profile picture */
  @Delete('me/avatar')
  @RequirePermissions('files:create')
  clearAvatar(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenantId: string) {
    return this.usersService.update(user.id, { avatarUrl: null }, tenantId, user.id);
  }

  @Post('invite')
  @RequirePermissions('users:create')
  invite(
    @Body() dto: InviteUserDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.invite(dto, tenantId, user.id);
  }

  @Post()
  @RequirePermissions('users:create')
  create(
    @Body() dto: CreateUserDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.create(dto, tenantId, user.id);
  }

  @Get()
  @RequirePermissions('users:read')
  findAll(
    @Query() query: ListUsersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request & { tenantId?: string | null },
  ) {
    // Prefer TenantGuard-resolved tenant (supports SA x-tenant-id header).
    const tenantId = req.tenantId ?? user.tenantId ?? null;

    // Super Admin with no tenant scope → platform-wide user list.
    if (user.isSuperAdmin && !tenantId) {
      return this.usersService.findAllPlatform(query);
    }
    if (!tenantId) {
      throw new BadRequestException('Tenant context is missing');
    }
    return this.usersService.findAll(tenantId, query);
  }

  /**
   * GET /users/platform — Super Admin only.
   * Lists all platform users (including Super Admins) with no tenant context required.
   * Must be declared before :id so Nest does not treat "platform" as an id.
   */
  @Get('platform')
  @UseGuards(SuperAdminGuard)
  @RequirePermissions('users:read')
  findAllPlatform(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAllPlatform(query);
  }

  /**
   * DELETE /users/platform/:id — Super Admin only.
   * Soft-deletes a platform user (orphan accounts after tenant delete, etc.).
   */
  @Delete('platform/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SuperAdminGuard)
  @RequirePermissions('users:delete')
  deletePlatformUser(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.usersService.deletePlatformUser(id, user.id);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.usersService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions('users:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.update(id, dto, tenantId, user.id);
  }

  @Patch(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users:update')
  deactivate(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.deactivate(id, tenantId, user.id);
  }

  @Patch(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users:update')
  reactivate(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.reactivate(id, tenantId, user.id);
  }

  @Post(':id/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users:update')
  assignRoles(
    @Param('id') id: string,
    @Body() dto: AssignUserRolesDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.assignRoles(id, dto, tenantId, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('users:delete')
  removeMember(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.removeMember(id, tenantId, user.id);
  }

  @Delete(':id/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('users:update')
  removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.removeRole(id, roleId, tenantId, user.id);
  }
}
