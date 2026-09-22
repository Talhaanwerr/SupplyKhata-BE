import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { IStorageProvider, UploadResult } from '../interfaces/storage.interface';

@Injectable()
export class LocalStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly uploadDir: string;

  constructor(private readonly configService: ConfigService) {
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', './uploads');
  }

  async upload(buffer: Buffer, key: string, _mimeType: string): Promise<UploadResult> {
    const fullPath = path.join(this.uploadDir, key);
    const dir = path.dirname(fullPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, buffer);

    this.logger.debug(`Saved file: ${fullPath}`);

    return {
      storedName: path.basename(key),
      path: fullPath.replace(/\\/g, '/'),
    };
  }

  async delete(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      this.logger.error(`Failed to delete file ${filePath}: ${String(err)}`);
    }
  }

  /**
   * Placeholder — local dev does not have signed URL support.
   * In production, swap this provider for S3StorageProvider.
   */
  async getSignedUrl(filePath: string, _expiresInSeconds = 3600): Promise<string> {
    // TODO: implement signed URL generation when switching to S3
    return `/files/download?path=${encodeURIComponent(filePath)}`;
  }
}
