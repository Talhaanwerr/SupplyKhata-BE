import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IStorageProvider, UploadResult } from '../interfaces/storage.interface';

/**
 * S3StorageProvider — placeholder for S3-compatible storage (AWS S3, MinIO, Cloudflare R2, etc.).
 *
 * To activate:
 * 1. Install: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 * 2. Set STORAGE_DRIVER=s3 and provide S3_* env vars.
 * 3. Replace the placeholder methods below with real AWS SDK calls.
 */
@Injectable()
export class S3StorageProvider implements IStorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string | undefined;

  constructor(private readonly configService: ConfigService) {
    // Only constructed when STORAGE_DRIVER=s3 — require credentials then.
    this.bucket = this.configService.getOrThrow<string>('S3_BUCKET');
    this.region = this.configService.getOrThrow<string>('S3_REGION');
    this.endpoint = this.configService.get<string>('S3_ENDPOINT');

    if (
      !this.configService.get<string>('S3_ACCESS_KEY_ID') ||
      !this.configService.get<string>('S3_SECRET_ACCESS_KEY')
    ) {
      this.logger.warn('STORAGE_DRIVER=s3 but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async upload(buffer: Buffer, key: string, mimeType: string): Promise<UploadResult> {
    /**
     * TODO: replace with actual S3 PutObjectCommand
     *
     * const client = new S3Client({ region: this.region, endpoint: this.endpoint });
     * await client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: mimeType }));
     */
    this.logger.warn('S3 upload is not yet implemented — configure AWS SDK');
    throw new Error('S3 storage is not yet configured');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(key: string): Promise<void> {
    /**
     * TODO: replace with actual S3 DeleteObjectCommand
     */
    this.logger.warn('S3 delete is not yet implemented');
    throw new Error('S3 storage is not yet configured');
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    /**
     * TODO: replace with actual getSignedUrl from @aws-sdk/s3-request-presigner
     *
     * const client = new S3Client({ region: this.region, endpoint: this.endpoint });
     * const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
     * return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
     */
    this.logger.warn('S3 signed URL is not yet implemented');
    void expiresInSeconds;
    throw new Error('S3 storage is not yet configured');
  }
}
