-- CreateTable
CREATE TABLE `boms` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `boms_tenantId_idx`(`tenantId`),
    INDEX `boms_tenantId_productId_idx`(`tenantId`, `productId`),
    INDEX `boms_tenantId_productId_isActive_idx`(`tenantId`, `productId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_lines` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `rawMaterialId` VARCHAR(191) NOT NULL,
    `qtyPerOutputUnit` DECIMAL(12, 6) NOT NULL,

    INDEX `bom_lines_tenantId_idx`(`tenantId`),
    INDEX `bom_lines_tenantId_bomId_idx`(`tenantId`, `bomId`),
    UNIQUE INDEX `bom_lines_bomId_rawMaterialId_key`(`bomId`, `rawMaterialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_bomId_fkey` FOREIGN KEY (`bomId`) REFERENCES `boms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
