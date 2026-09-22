import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  imports: [PrismaModule],
  controllers: [RolesController],
  providers: [RolesService, PermissionsGuard, RolesGuard, TenantGuard],
  exports: [RolesService],
})
export class RolesModule {}
