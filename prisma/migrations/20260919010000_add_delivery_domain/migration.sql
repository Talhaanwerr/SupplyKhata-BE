-- CreateTable
CREATE TABLE `delivery_runs` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `riderId` VARCHAR(191) NOT NULL,
    `vehicleId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `openingCash` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `closingCash` DECIMAL(10, 2) NULL,
    `totalSales` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `totalCashCollected` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `totalExpenses` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `delivery_runs_tenantId_idx`(`tenantId`),
    INDEX `delivery_runs_tenantId_riderId_idx`(`tenantId`, `riderId`),
    INDEX `delivery_runs_tenantId_date_idx`(`tenantId`, `date`),
    INDEX `delivery_runs_tenantId_status_idx`(`tenantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_run_stocks` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `deliveryRunId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `stockType` ENUM('OPENING', 'CLOSING') NOT NULL,
    `filledCount` INTEGER NOT NULL DEFAULT 0,
    `emptyCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `delivery_run_stocks_tenantId_idx`(`tenantId`),
    INDEX `delivery_run_stocks_productId_idx`(`productId`),
    UNIQUE INDEX `delivery_run_stocks_deliveryRunId_productId_stockType_key`(`deliveryRunId`, `productId`, `stockType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `deliveryRunId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `deliveryDate` DATETIME(3) NOT NULL,
    `cashReceived` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `paymentMethod` ENUM('CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'OTHER') NOT NULL DEFAULT 'CASH',
    `status` ENUM('DELIVERED', 'PARTIAL', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'DELIVERED',
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `deliveries_tenantId_idx`(`tenantId`),
    INDEX `deliveries_tenantId_deliveryRunId_idx`(`tenantId`, `deliveryRunId`),
    INDEX `deliveries_tenantId_customerId_idx`(`tenantId`, `customerId`),
    INDEX `deliveries_tenantId_deliveryDate_idx`(`tenantId`, `deliveryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_items` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `deliveryId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `quantityDelivered` INTEGER NOT NULL,
    `emptiesReceived` INTEGER NOT NULL DEFAULT 0,
    `sellingPriceSnapshot` DECIMAL(10, 2) NOT NULL,
    `unitCostSnapshot` DECIMAL(10, 2) NOT NULL,
    `lineTotal` DECIMAL(10, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `delivery_items_tenantId_idx`(`tenantId`),
    INDEX `delivery_items_tenantId_deliveryId_idx`(`tenantId`, `deliveryId`),
    INDEX `delivery_items_tenantId_productId_idx`(`tenantId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `container_movements` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `deliveryItemId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `vehicleId` VARCHAR(191) NULL,
    `movementType` ENUM('DELIVERED_TO_CUSTOMER', 'RETURNED_FROM_CUSTOMER', 'LOADED_TO_VEHICLE', 'UNLOADED_FROM_VEHICLE', 'LOST', 'DAMAGED', 'ADJUSTMENT') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `container_movements_tenantId_productId_idx`(`tenantId`, `productId`),
    INDEX `container_movements_tenantId_customerId_productId_idx`(`tenantId`, `customerId`, `productId`),
    INDEX `container_movements_tenantId_movementType_idx`(`tenantId`, `movementType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_ledger_entries` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `entryType` ENUM('DELIVERY_SALE', 'PAYMENT', 'ADJUSTMENT', 'OPENING_BALANCE', 'REFUND') NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `referenceId` VARCHAR(191) NULL,
    `referenceType` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_ledger_entries_tenantId_customerId_idx`(`tenantId`, `customerId`),
    INDEX `customer_ledger_entries_tenantId_customerId_createdAt_idx`(`tenantId`, `customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `delivery_runs` ADD CONSTRAINT `delivery_runs_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_runs` ADD CONSTRAINT `delivery_runs_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_runs` ADD CONSTRAINT `delivery_runs_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `vehicles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_run_stocks` ADD CONSTRAINT `delivery_run_stocks_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_run_stocks` ADD CONSTRAINT `delivery_run_stocks_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_run_stocks` ADD CONSTRAINT `delivery_run_stocks_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deliveries` ADD CONSTRAINT `deliveries_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deliveries` ADD CONSTRAINT `deliveries_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deliveries` ADD CONSTRAINT `deliveries_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_items` ADD CONSTRAINT `delivery_items_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_items` ADD CONSTRAINT `delivery_items_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `deliveries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_items` ADD CONSTRAINT `delivery_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_deliveryItemId_fkey` FOREIGN KEY (`deliveryItemId`) REFERENCES `delivery_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_ledger_entries` ADD CONSTRAINT `customer_ledger_entries_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_ledger_entries` ADD CONSTRAINT `customer_ledger_entries_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
