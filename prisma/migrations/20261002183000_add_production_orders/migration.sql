-- CreateEnum
CREATE TABLE `production_orders` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `plannedQty` DECIMAL(12, 3) NOT NULL,
    `actualQty` DECIMAL(12, 3) NULL,
    `scrapQty` DECIMAL(12, 3) NULL,
    `varianceNote` TEXT NULL,
    `scrapReason` TEXT NULL,
    `cancelReason` TEXT NULL,
    `status` ENUM('DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `notes` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `production_orders_tenantId_idx`(`tenantId`),
    INDEX `production_orders_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `production_orders_tenantId_productId_idx`(`tenantId`, `productId`),
    INDEX `production_orders_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_consume_lines` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionOrderId` VARCHAR(191) NOT NULL,
    `rawMaterialId` VARCHAR(191) NOT NULL,
    `qtyPerOutputUnit` DECIMAL(12, 6) NOT NULL,
    `qtyConsumed` DECIMAL(12, 3) NOT NULL,

    INDEX `production_consume_lines_tenantId_idx`(`tenantId`),
    INDEX `production_consume_lines_tenantId_productionOrderId_idx`(`tenantId`, `productionOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `production_orders` ADD CONSTRAINT `production_orders_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_orders` ADD CONSTRAINT `production_orders_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_orders` ADD CONSTRAINT `production_orders_bomId_fkey` FOREIGN KEY (`bomId`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_orders` ADD CONSTRAINT `production_orders_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_orders` ADD CONSTRAINT `production_orders_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_consume_lines` ADD CONSTRAINT `production_consume_lines_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_consume_lines` ADD CONSTRAINT `production_consume_lines_productionOrderId_fkey` FOREIGN KEY (`productionOrderId`) REFERENCES `production_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_consume_lines` ADD CONSTRAINT `production_consume_lines_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
