import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { TenantsModule } from './tenants/tenants.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { FilesModule } from './files/files.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ExportModule } from './export/export.module';
import { AreasModule } from './areas/areas.module';
import { ProductsModule } from './products/products.module';
import { CustomersModule } from './customers/customers.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { DeliveryRunsModule } from './delivery-runs/delivery-runs.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { PaymentsModule } from './payments/payments.module';
import { RefillBatchesModule } from './refill-batches/refill-batches.module';
import { ExpensesModule } from './expenses/expenses.module';
import { CashHandoversModule } from './cash-handovers/cash-handovers.module';
import { ContainerInventoryModule } from './container-inventory/container-inventory.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { CollectionsModule } from './collections/collections.module';
import { envValidationSchema } from './config/env.validation';
import { winstonConfig } from './config/logger.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true },
    }),

    WinstonModule.forRoot(winstonConfig),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.getOrThrow<number>('THROTTLE_TTL'),
          limit: configService.getOrThrow<number>('THROTTLE_LIMIT'),
        },
      ],
      inject: [ConfigService],
    }),

    PrismaModule,
    MailModule,
    AuditLogsModule,
    HealthModule,
    AuthModule,
    TenantsModule,
    RolesModule,
    UsersModule,
    SettingsModule,
    FeatureFlagsModule,
    FilesModule,
    NotificationsModule,
    ExportModule,
    AreasModule,
    ProductsModule,
    CustomersModule,
    VehiclesModule,
    DeliveryRunsModule,
    DeliveriesModule,
    PaymentsModule,
    RefillBatchesModule,
    ExpensesModule,
    CashHandoversModule,
    ContainerInventoryModule,
    DashboardModule,
    ReportsModule,
    CollectionsModule,
  ],
})
export class AppModule {}
