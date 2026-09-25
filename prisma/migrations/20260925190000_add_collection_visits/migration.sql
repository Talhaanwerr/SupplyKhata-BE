-- CollectionVisit for field collections workflow

CREATE TABLE `collection_visits` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `collectorId` VARCHAR(191) NOT NULL,
    `visitDate` DATETIME(3) NOT NULL,
    `outcome` ENUM('COLLECTED', 'PARTIAL', 'PROMISED', 'NO_CONTACT', 'SKIPPED') NOT NULL,
    `amountCollected` DECIMAL(10, 2) NULL,
    `paymentId` VARCHAR(191) NULL,
    `followUpDate` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `collection_visits_tenantId_visitDate_idx`(`tenantId`, `visitDate`),
    INDEX `collection_visits_tenantId_collectorId_idx`(`tenantId`, `collectorId`),
    INDEX `collection_visits_tenantId_followUpDate_idx`(`tenantId`, `followUpDate`),
    INDEX `collection_visits_tenantId_customerId_idx`(`tenantId`, `customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `collection_visits` ADD CONSTRAINT `collection_visits_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `collection_visits` ADD CONSTRAINT `collection_visits_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `collection_visits` ADD CONSTRAINT `collection_visits_collectorId_fkey` FOREIGN KEY (`collectorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `collection_visits` ADD CONSTRAINT `collection_visits_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
