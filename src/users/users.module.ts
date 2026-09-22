import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { StaffController } from './staff.controller';
import { FilesModule } from '../files/files.module';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  imports: [FilesModule],
  controllers: [UsersController, StaffController],
  providers: [UsersService, PermissionsGuard, TenantGuard],
  exports: [UsersService],
})
export class UsersModule {}
