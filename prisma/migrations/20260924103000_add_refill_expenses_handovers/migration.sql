-- CreateTable
CREATE TABLE `refill_batches` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `cansFilledCount` INTEGER NOT NULL,
    `costPerUnit` DECIMAL(10, 2) NOT NULL,
    `totalCost` DECIMAL(10, 2) NOT NULL,
    `notes` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `refill_batches_tenantId_idx`(`tenantId`),
    INDEX `refill_batches_tenantId_productId_idx`(`tenantId`, `productId`),
    INDEX `refill_batches_tenantId_date_idx`(`tenantId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_run_refill_loads` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `deliveryRunId` VARCHAR(191) NOT NULL,
    `refillBatchId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `quantityLoaded` INTEGER NOT NULL,

    INDEX `delivery_run_refill_loads_tenantId_refillBatchId_idx`(`tenantId`, `refillBatchId`),
    INDEX `delivery_run_refill_loads_tenantId_deliveryRunId_idx`(`tenantId`, `deliveryRunId`),
    UNIQUE INDEX `delivery_run_refill_loads_deliveryRunId_refillBatchId_key`(`deliveryRunId`, `refillBatchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `date` DATETIME(3) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `vehicleId` VARCHAR(191) NULL,
    `deliveryRunId` VARCHAR(191) NULL,
    `staffId` VARCHAR(191) NULL,
    `paymentMethod` ENUM('CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'OTHER') NOT NULL DEFAULT 'CASH',
    `reference` VARCHAR(191) NULL,
    `isPaidByRider` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `expenses_tenantId_idx`(`tenantId`),
    INDEX `expenses_tenantId_date_idx`(`tenantId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_handovers` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `riderId` VARCHAR(191) NOT NULL,
    `receivedById` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `handoverDate` DATETIME(3) NOT NULL,
    `reference` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `deliveryRunId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `cash_handovers_tenantId_idx`(`tenantId`),
    INDEX `cash_handovers_tenantId_riderId_idx`(`tenantId`, `riderId`),
    INDEX `cash_handovers_tenantId_handoverDate_idx`(`tenantId`, `handoverDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `refill_batches` ADD CONSTRAINT `refill_batches_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refill_batches` ADD CONSTRAINT `refill_batches_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refill_batches` ADD CONSTRAINT `refill_batches_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `delivery_run_refill_loads` ADD CONSTRAINT `delivery_run_refill_loads_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `delivery_run_refill_loads` ADD CONSTRAINT `delivery_run_refill_loads_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `delivery_run_refill_loads` ADD CONSTRAINT `delivery_run_refill_loads_refillBatchId_fkey` FOREIGN KEY (`refillBatchId`) REFERENCES `refill_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `delivery_run_refill_loads` ADD CONSTRAINT `delivery_run_refill_loads_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `expenses` ADD CONSTRAINT `expenses_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_staffId_fkey` FOREIGN KEY (`staffId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `cash_handovers` ADD CONSTRAINT `cash_handovers_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `cash_handovers` ADD CONSTRAINT `cash_handovers_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `cash_handovers` ADD CONSTRAINT `cash_handovers_receivedById_fkey` FOREIGN KEY (`receivedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `cash_handovers` ADD CONSTRAINT `cash_handovers_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
