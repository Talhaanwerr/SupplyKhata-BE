-- CreateTable
CREATE TABLE `platform_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'platform',
    `appName` VARCHAR(191) NOT NULL DEFAULT 'SaaS Boilerplate',
    `supportEmail` VARCHAR(191) NOT NULL DEFAULT 'support@example.com',
    `defaultTimezone` VARCHAR(191) NOT NULL DEFAULT 'UTC',
    `defaultCurrency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_materials` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `unit` ENUM('KG', 'LTR', 'PCS') NOT NULL,
    `sku` VARCHAR(191) NULL,
    `defaultCost` DECIMAL(12, 2) NULL,
    `reorderLevel` DECIMAL(12, 3) NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `raw_materials_tenantId_idx`(`tenantId`),
    INDEX `raw_materials_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `raw_materials_tenantId_name_idx`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_material_balances` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `rawMaterialId` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `raw_material_balances_tenantId_idx`(`tenantId`),
    INDEX `raw_material_balances_tenantId_rawMaterialId_idx`(`tenantId`, `rawMaterialId`),
    UNIQUE INDEX `raw_material_balances_tenantId_locationId_rawMaterialId_key`(`tenantId`, `locationId`, `rawMaterialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_material_movements` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `rawMaterialId` VARCHAR(191) NOT NULL,
    `type` ENUM('OPENING', 'ADJUSTMENT', 'PURCHASE_IN', 'PRODUCTION_CONSUME') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `referenceType` VARCHAR(191) NULL,
    `referenceId` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `raw_material_movements_tenantId_rawMaterialId_createdAt_idx`(`tenantId`, `rawMaterialId`, `createdAt`),
    INDEX `raw_material_movements_tenantId_locationId_idx`(`tenantId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `raw_materials` ADD CONSTRAINT `raw_materials_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_balances` ADD CONSTRAINT `raw_material_balances_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_balances` ADD CONSTRAINT `raw_material_balances_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_balances` ADD CONSTRAINT `raw_material_balances_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_movements` ADD CONSTRAINT `raw_material_movements_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_movements` ADD CONSTRAINT `raw_material_movements_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_movements` ADD CONSTRAINT `raw_material_movements_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_material_movements` ADD CONSTRAINT `raw_material_movements_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
