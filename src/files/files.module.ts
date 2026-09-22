import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3StorageProvider } from './providers/s3-storage.provider';
import { STORAGE_PROVIDER, IStorageProvider } from './interfaces/storage.interface';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [FilesController],
  providers: [
    FilesService,
    LocalStorageProvider,
    PermissionsGuard,
    TenantGuard,
    {
      provide: STORAGE_PROVIDER,
      useFactory: (configService: ConfigService, local: LocalStorageProvider): IStorageProvider => {
        const driver = configService.get<string>('STORAGE_DRIVER', 'local');

        // Only construct S3 provider when explicitly selected — S3_* env vars
        // are not required for local development.
        if (driver === 's3') {
          return new S3StorageProvider(configService);
        }

        return local;
      },
      inject: [ConfigService, LocalStorageProvider],
    },
  ],
  exports: [FilesService],
})
export class FilesModule {}
