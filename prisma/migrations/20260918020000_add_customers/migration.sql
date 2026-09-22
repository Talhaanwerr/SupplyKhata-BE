-- CreateEnum
-- Prisma maps MySQL enums as native ENUM types

-- CreateTable
CREATE TABLE `customers` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `secondaryPhone` VARCHAR(191) NULL,
    `address` TEXT NOT NULL,
    `areaId` VARCHAR(191) NOT NULL,
    `locationNotes` TEXT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `paymentCycle` ENUM('CASH_ON_DELIVERY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM') NOT NULL DEFAULT 'CASH_ON_DELIVERY',
    `billingDueDate` INTEGER NULL,
    `openingReceivableBalance` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `containerDeposit` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `defaultRiderId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `customers_tenantId_idx`(`tenantId`),
    INDEX `customers_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `customers_tenantId_areaId_idx`(`tenantId`, `areaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_product_prices` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `pricePerUnit` DECIMAL(10, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `customer_product_prices_tenantId_customerId_idx`(`tenantId`, `customerId`),
    UNIQUE INDEX `customer_product_prices_customerId_productId_key`(`customerId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_areaId_fkey` FOREIGN KEY (`areaId`) REFERENCES `areas`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_defaultRiderId_fkey` FOREIGN KEY (`defaultRiderId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_product_prices` ADD CONSTRAINT `customer_product_prices_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_product_prices` ADD CONSTRAINT `customer_product_prices_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
