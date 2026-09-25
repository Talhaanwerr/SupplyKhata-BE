-- Interval-based recurring delivery schedules + daily planned stops

CREATE TABLE `customer_delivery_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `intervalDays` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `startDate` DATETIME(3) NULL,
    `defaultRiderId` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_delivery_schedules_customerId_key`(`customerId`),
    UNIQUE INDEX `customer_delivery_schedules_tenantId_customerId_key`(`tenantId`, `customerId`),
    INDEX `customer_delivery_schedules_tenantId_isActive_idx`(`tenantId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `customer_delivery_schedule_items` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `defaultQuantity` DECIMAL(12, 3) NOT NULL,

    UNIQUE INDEX `customer_delivery_schedule_items_scheduleId_productId_key`(`scheduleId`, `productId`),
    INDEX `customer_delivery_schedule_items_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `planned_delivery_stops` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `planDate` DATETIME(3) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NULL,
    `deliveryRunId` VARCHAR(191) NULL,
    `deliveryId` VARCHAR(191) NULL,
    `status` ENUM('PLANNED', 'INCLUDED', 'COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PLANNED',
    `source` ENUM('SCHEDULE', 'MANUAL') NOT NULL DEFAULT 'SCHEDULE',
    `skipReason` VARCHAR(191) NULL,
    `failReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `planned_delivery_stops_deliveryId_key`(`deliveryId`),
    INDEX `planned_delivery_stops_tenantId_planDate_status_idx`(`tenantId`, `planDate`, `status`),
    INDEX `planned_delivery_stops_tenantId_customerId_planDate_idx`(`tenantId`, `customerId`, `planDate`),
    INDEX `planned_delivery_stops_tenantId_deliveryRunId_idx`(`tenantId`, `deliveryRunId`),
    INDEX `planned_delivery_stops_tenantId_scheduleId_status_idx`(`tenantId`, `scheduleId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `planned_delivery_stop_items` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `plannedStopId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `plannedQuantity` DECIMAL(12, 3) NOT NULL,

    UNIQUE INDEX `planned_delivery_stop_items_plannedStopId_productId_key`(`plannedStopId`, `productId`),
    INDEX `planned_delivery_stop_items_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `customer_delivery_schedules` ADD CONSTRAINT `customer_delivery_schedules_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `customer_delivery_schedules` ADD CONSTRAINT `customer_delivery_schedules_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `customer_delivery_schedules` ADD CONSTRAINT `customer_delivery_schedules_defaultRiderId_fkey` FOREIGN KEY (`defaultRiderId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `customer_delivery_schedule_items` ADD CONSTRAINT `customer_delivery_schedule_items_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `customer_delivery_schedule_items` ADD CONSTRAINT `customer_delivery_schedule_items_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `customer_delivery_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `customer_delivery_schedule_items` ADD CONSTRAINT `customer_delivery_schedule_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `planned_delivery_stops` ADD CONSTRAINT `planned_delivery_stops_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stops` ADD CONSTRAINT `planned_delivery_stops_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stops` ADD CONSTRAINT `planned_delivery_stops_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `customer_delivery_schedules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stops` ADD CONSTRAINT `planned_delivery_stops_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stops` ADD CONSTRAINT `planned_delivery_stops_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `deliveries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `planned_delivery_stop_items` ADD CONSTRAINT `planned_delivery_stop_items_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stop_items` ADD CONSTRAINT `planned_delivery_stop_items_plannedStopId_fkey` FOREIGN KEY (`plannedStopId`) REFERENCES `planned_delivery_stops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `planned_delivery_stop_items` ADD CONSTRAINT `planned_delivery_stop_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
