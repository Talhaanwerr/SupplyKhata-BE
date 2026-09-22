import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { IStorageProvider, STORAGE_PROVIDER } from './interfaces/storage.interface';
import { UploadFileDto } from './dto/upload-file.dto';
import { ListFilesQueryDto, FileVisibility } from './dto/list-files-query.dto';

// Allowed MIME types — never accept executables, server-side scripts, or SVG
// (SVG is excluded because it can contain inline <script> and event handlers,
// making it an XSS vector when served from the same origin).
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'application/zip',
]);

type FileItem = {
  id: string;
  tenantId: string;
  uploadedById: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  path: string;
  visibility: FileVisibility;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class FilesService {
  private readonly maxSizeBytes: number;
  private readonly uploadDir: string;
  private readonly storageDriver: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly configService: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {
    const maxMb = this.configService.get<number>('MAX_FILE_SIZE_MB', 10);
    this.maxSizeBytes = maxMb * 1024 * 1024;
    this.uploadDir = path.resolve(this.configService.get<string>('UPLOAD_DIR', './uploads'));
    this.storageDriver = this.configService.get<string>('STORAGE_DRIVER', 'local');
  }

  // ─── Upload ────────────────────────────────────────────────────────────

  async upload(
    file: Express.Multer.File,
    dto: UploadFileDto,
    tenantId: string,
    userId: string,
  ): Promise<FileItem> {
    this.validateFile(file);

    const storedName = this.buildStoredName(file.originalname);
    // Tenant-based path: tenants/{tenantId}/users/{userId}/{storedName}
    const key = `tenants/${tenantId}/users/${userId}/${storedName}`;

    const result = await this.storage.upload(file.buffer, key, file.mimetype);
    const visibility = dto.visibility ?? FileVisibility.PRIVATE;

    const record = await this.prisma.file.create({
      data: {
        tenantId,
        uploadedById: userId,
        originalName: file.originalname,
        storedName,
        mimeType: file.mimetype,
        size: file.size,
        path: result.path,
        visibility,
      },
    });

    await this.audit.write({
      tenantId,
      actorId: userId,
      module: 'files',
      action: 'UPLOAD',
      entityId: record.id,
      newValue: { originalName: file.originalname, size: file.size, mimeType: file.mimetype },
    });

    return record as FileItem;
  }

  // ─── List ──────────────────────────────────────────────────────────────

  async findAll(tenantId: string, query: ListFilesQueryDto): Promise<PaginatedData<FileItem>> {
    const { skip, take } = getPaginationParams(query);

    const where: {
      tenantId: string;
      deletedAt: null;
      visibility?: FileVisibility;
      OR?: Array<{ originalName: { contains: string } } | { storedName: { contains: string } }>;
    } = {
      tenantId,
      deletedAt: null,
    };

    if (query.visibility) where.visibility = query.visibility;

    if (query.search?.trim()) {
      const s = query.search.trim();
      where.OR = [{ originalName: { contains: s } }, { storedName: { contains: s } }];
    }

    const [items, total] = await Promise.all([
      this.prisma.file.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.file.count({ where }),
    ]);

    return {
      items: items as FileItem[],
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  // ─── Get one ───────────────────────────────────────────────────────────

  async findOne(id: string, tenantId: string, requesterId: string): Promise<FileItem> {
    const file = await this.findTenantFileOrThrow(id, tenantId);

    // Private files only accessible by uploader or tenant admin (checked via permission in controller)
    if (file.visibility === FileVisibility.PRIVATE && file.uploadedById !== requesterId) {
      throw new ForbiddenException('Access to this file is not allowed');
    }

    return file;
  }

  // ─── Public content (avatars / PUBLIC files) ───────────────────────────

  /**
   * Stream a PUBLIC file by id. Used as img src for avatars — no auth required.
   */
  async getPublicContentStream(id: string): Promise<StreamableFile> {
    const file = await this.prisma.file.findFirst({
      where: { id, deletedAt: null, visibility: FileVisibility.PUBLIC },
    });
    if (!file) throw new NotFoundException('File not found');
    return this.toStreamableFile(file as FileItem);
  }

  /**
   * Legacy local download by storage path (old avatarUrl format).
   * Only serves files that exist under UPLOAD_DIR and are marked PUBLIC in DB.
   */
  async getPublicContentByPath(rawPath: string): Promise<StreamableFile> {
    if (!rawPath?.trim()) throw new BadRequestException('path is required');

    const absolute = this.resolveUnderUploadDir(rawPath);
    if (!fs.existsSync(absolute)) throw new NotFoundException('File not found');

    const normalized = absolute.replace(/\\/g, '/');
    const rawNormalized = rawPath.replace(/\\/g, '/');

    // Platform avatars (SA) may not have a File DB row
    if (
      /[/\\]platform[/\\]users[/\\]/.test(normalized) ||
      /[/\\]platform[/\\]users[/\\]/.test(rawNormalized)
    ) {
      const ext = path.extname(absolute).toLowerCase();
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/jpeg';
      return new StreamableFile(fs.createReadStream(absolute), {
        type: mime,
        disposition: `inline; filename="${path.basename(absolute)}"`,
      });
    }

    let matched = await this.prisma.file.findFirst({
      where: {
        deletedAt: null,
        visibility: FileVisibility.PUBLIC,
        OR: [{ path: normalized }, { path: rawNormalized }],
      },
    });

    if (!matched) {
      matched = await this.prisma.file.findFirst({
        where: {
          deletedAt: null,
          visibility: FileVisibility.PUBLIC,
          path: { endsWith: path.basename(absolute) },
        },
      });
    }

    if (!matched) throw new NotFoundException('File not found');
    return this.toStreamableFile(matched as FileItem, absolute);
  }

  /**
   * Stream a file for an authenticated tenant member.
   * PUBLIC: any tenant member. PRIVATE: uploader only (same as findOne).
   */
  async getAuthenticatedContentStream(
    id: string,
    tenantId: string,
    requesterId: string,
  ): Promise<StreamableFile> {
    const file = await this.findOne(id, tenantId, requesterId);
    return this.toStreamableFile(file);
  }

  // ─── Signed URL ────────────────────────────────────────────────────────

  async getSignedUrl(
    id: string,
    tenantId: string,
    requesterId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const file = await this.findOne(id, tenantId, requesterId);

    if (this.storageDriver === 'local') {
      // PUBLIC assets can be hot-linked without auth; PRIVATE needs Authorization
      const pathSuffix =
        file.visibility === FileVisibility.PUBLIC
          ? `/api/v1/files/${id}/content`
          : `/api/v1/files/${id}/download`;
      return {
        url: `${this.getPublicApiBase()}${pathSuffix}`,
        expiresInSeconds: 3600,
      };
    }

    const url = await this.storage.getSignedUrl(file.path, 3600);
    return { url, expiresInSeconds: 3600 };
  }

  // ─── Delete ────────────────────────────────────────────────────────────

  async delete(id: string, tenantId: string, actorId: string): Promise<void> {
    const file = await this.findTenantFileOrThrow(id, tenantId);

    await Promise.all([
      this.prisma.file.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.storage.delete(file.path).catch(() => {
        // Storage deletion failure must not break the soft-delete record
      }),
    ]);

    await this.audit.write({
      tenantId,
      actorId,
      module: 'files',
      action: 'DELETE',
      entityId: id,
      oldValue: { originalName: file.originalName, path: file.path },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private getPublicApiBase(): string {
    return this.configService.getOrThrow<string>('API_PUBLIC_URL').replace(/\/$/, '');
  }

  private resolveUnderUploadDir(rawPath: string): string {
    const decoded = decodeURIComponent(rawPath.trim());
    // Strip a leading "uploads/" so join(uploadDir, ...) does not double the folder
    const stripped = decoded.replace(/^[.]?[/\\]?uploads[/\\]/i, '');
    const candidate = path.isAbsolute(decoded)
      ? path.resolve(decoded)
      : path.resolve(this.uploadDir, path.normalize(stripped).replace(/^(\.\.[/\\])+/, ''));

    const relative = path.relative(this.uploadDir, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ForbiddenException('Invalid file path');
    }
    return candidate;
  }

  private toStreamableFile(file: FileItem, absoluteOverride?: string): StreamableFile {
    const absolute = absoluteOverride ?? this.resolveUnderUploadDir(file.path);
    if (!fs.existsSync(absolute)) throw new NotFoundException('File not found');

    const stream = fs.createReadStream(absolute);
    return new StreamableFile(stream, {
      type: file.mimeType || 'application/octet-stream',
      disposition: `inline; filename="${file.originalName.replace(/"/g, '')}"`,
    });
  }

  private validateFile(file: Express.Multer.File): void {
    if (file.size > this.maxSizeBytes) {
      const maxMb = this.configService.get<number>('MAX_FILE_SIZE_MB', 10);
      throw new BadRequestException(`File exceeds maximum size of ${maxMb} MB`);
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`File type '${file.mimetype}' is not allowed`);
    }
  }

  private buildStoredName(originalName: string): string {
    const ext = path.extname(originalName).toLowerCase();
    const uniqueId = crypto.randomBytes(16).toString('hex');
    return `${uniqueId}${ext}`;
  }

  private async findTenantFileOrThrow(id: string, tenantId: string): Promise<FileItem> {
    const file = await this.prisma.file.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!file) throw new NotFoundException('File not found');
    return file as FileItem;
  }
}
