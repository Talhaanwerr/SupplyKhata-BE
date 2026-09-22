import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ParseFilePipe,
  MaxFileSizeValidator,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { FilesService } from './files.service';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { UploadFileDto } from './dto/upload-file.dto';

// Evaluated once at startup from env. The service also validates using the same
// env var, so the controller and service limits are always in sync.
const MAX_UPLOAD_BYTES = parseInt(process.env['MAX_FILE_SIZE_MB'] ?? '10', 10) * 1024 * 1024;

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'files', version: '1' })
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  /**
   * GET /files/download?path=...
   * Legacy public file serve (old avatarUrl format). Prefer GET /files/:id/content.
   */
  @Get('download')
  @Public()
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=86400')
  downloadByPath(@Query('path') filePath: string): Promise<StreamableFile> {
    return this.filesService.getPublicContentByPath(filePath);
  }

  /** POST /files — upload a file (multipart/form-data, field name: file) */
  @Post()
  @RequirePermissions('files:create')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  upload(
    @UploadedFile(
      new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES })] }),
    )
    file: Express.Multer.File,
    @Body() dto: UploadFileDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.upload(file, dto, tenantId, user.id);
  }

  /** GET /files — list tenant files */
  @Get()
  @RequirePermissions('files:read')
  findAll(@Query() query: ListFilesQueryDto, @CurrentTenant() tenantId: string) {
    return this.filesService.findAll(tenantId, query);
  }

  /**
   * GET /files/:id/content — stream PUBLIC file bytes (avatars / logos).
   * Must be declared before GET /files/:id so "content" is not treated as an id.
   */
  @Get(':id/content')
  @Public()
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=86400')
  getContent(@Param('id') id: string): Promise<StreamableFile> {
    return this.filesService.getPublicContentStream(id);
  }

  /**
   * GET /files/:id/download — authenticated download (PUBLIC or PRIVATE for uploader).
   */
  @Get(':id/download')
  @RequirePermissions('files:read')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  downloadAuthenticated(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    return this.filesService.getAuthenticatedContentStream(id, tenantId, user.id);
  }

  /** GET /files/:id — get file metadata */
  @Get(':id')
  @RequirePermissions('files:read')
  findOne(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.findOne(id, tenantId, user.id);
  }

  /** GET /files/:id/signed-url — generate a private download link */
  @Get(':id/signed-url')
  @RequirePermissions('files:read')
  getSignedUrl(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.getSignedUrl(id, tenantId, user.id);
  }

  /** DELETE /files/:id — soft-delete a file */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('files:delete')
  delete(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.delete(id, tenantId, user.id);
  }
}
