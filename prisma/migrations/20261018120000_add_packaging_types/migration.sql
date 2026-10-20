-- CreateTable
CREATE TABLE `packaging_types` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `capacity` DECIMAL(10, 2) NULL,
    `notes` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `packaging_types_tenantId_idx`(`tenantId`),
    INDEX `packaging_types_tenantId_isActive_idx`(`tenantId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `packaging_types` ADD CONSTRAINT `packaging_types_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable products
ALTER TABLE `products` ADD COLUMN `packagingTypeId` VARCHAR(191) NULL;

CREATE INDEX `products_tenantId_packagingTypeId_idx` ON `products`(`tenantId`, `packagingTypeId`);

ALTER TABLE `products` ADD CONSTRAINT `products_packagingTypeId_fkey` FOREIGN KEY (`packagingTypeId`) REFERENCES `packaging_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable container_movements: packaging type + optional product
ALTER TABLE `container_movements` ADD COLUMN `packagingTypeId` VARCHAR(191) NULL;

ALTER TABLE `container_movements` MODIFY `productId` VARCHAR(191) NULL;

CREATE INDEX `container_movements_tenantId_packagingTypeId_idx` ON `container_movements`(`tenantId`, `packagingTypeId`);

CREATE INDEX `container_movements_tenantId_customerId_packagingTypeId_idx` ON `container_movements`(`tenantId`, `customerId`, `packagingTypeId`);

ALTER TABLE `container_movements` ADD CONSTRAINT `container_movements_packagingTypeId_fkey` FOREIGN KEY (`packagingTypeId`) REFERENCES `packaging_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
