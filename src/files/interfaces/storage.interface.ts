export interface UploadResult {
  /** Stored file name (unique, sanitised) */
  storedName: string;
  /** Full storage path / S3 key */
  path: string;
  /** Public URL for public files; undefined for private files */
  publicUrl?: string;
}

/**
 * IStorageProvider — implemented by LocalStorageProvider and S3StorageProvider.
 * Adding a new driver (GCS, Azure Blob, etc.) only requires implementing this contract.
 */
export interface IStorageProvider {
  upload(buffer: Buffer, key: string, mimeType: string): Promise<UploadResult>;

  delete(path: string): Promise<void>;

  /**
   * Generate a time-limited signed URL for private files.
   * Returns a placeholder for drivers that do not yet implement signing.
   */
  getSignedUrl(path: string, expiresInSeconds?: number): Promise<string>;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
