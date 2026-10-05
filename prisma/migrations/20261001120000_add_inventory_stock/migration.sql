-- Warehouse inventory (finished goods). Separate from delivery_run_stocks (truck).

-- AlterTable
ALTER TABLE `products` ADD COLUMN `reorderLevel` DECIMAL(12, 3) NULL;

-- CreateTable
CREATE TABLE `stock_locations` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('WAREHOUSE', 'PLANT', 'STORE') NOT NULL DEFAULT 'WAREHOUSE',
    `code` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_locations_tenantId_idx`(`tenantId`),
    INDEX `stock_locations_tenantId_isActive_idx`(`tenantId`, `isActive`),
    UNIQUE INDEX `stock_locations_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_balances` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_balances_tenantId_idx`(`tenantId`),
    INDEX `stock_balances_tenantId_productId_idx`(`tenantId`, `productId`),
    UNIQUE INDEX `stock_balances_tenantId_locationId_productId_key`(`tenantId`, `locationId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movements` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `type` ENUM('OPENING', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'PURCHASE_IN', 'PRODUCTION_IN', 'PRODUCTION_CONSUME', 'SALE_OUT') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `referenceType` VARCHAR(191) NULL,
    `referenceId` VARCHAR(191) NULL,
    `transferGroupId` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_movements_tenantId_productId_createdAt_idx`(`tenantId`, `productId`, `createdAt`),
    INDEX `stock_movements_tenantId_locationId_idx`(`tenantId`, `locationId`),
    INDEX `stock_movements_tenantId_transferGroupId_idx`(`tenantId`, `transferGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_locations` ADD CONSTRAINT `stock_locations_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
