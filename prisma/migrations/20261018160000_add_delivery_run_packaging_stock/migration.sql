-- CreateTable
CREATE TABLE `delivery_run_packaging_stocks` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `deliveryRunId` VARCHAR(191) NOT NULL,
    `packagingTypeId` VARCHAR(191) NOT NULL,
    `stockType` ENUM('OPENING', 'CLOSING') NOT NULL,
    `filledCount` INTEGER NOT NULL DEFAULT 0,
    `emptyCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `delivery_run_packaging_stocks_tenantId_idx`(`tenantId`),
    INDEX `delivery_run_packaging_stocks_packagingTypeId_idx`(`packagingTypeId`),
    UNIQUE INDEX `drps_run_type_stock_key`(`deliveryRunId`, `packagingTypeId`, `stockType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `delivery_run_packaging_stocks` ADD CONSTRAINT `delivery_run_packaging_stocks_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `delivery_run_packaging_stocks` ADD CONSTRAINT `delivery_run_packaging_stocks_deliveryRunId_fkey` FOREIGN KEY (`deliveryRunId`) REFERENCES `delivery_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `delivery_run_packaging_stocks` ADD CONSTRAINT `delivery_run_packaging_stocks_packagingTypeId_fkey` FOREIGN KEY (`packagingTypeId`) REFERENCES `packaging_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
