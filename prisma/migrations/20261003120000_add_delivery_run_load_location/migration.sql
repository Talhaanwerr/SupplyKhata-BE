-- AlterTable
ALTER TABLE `delivery_runs` ADD COLUMN `loadLocationId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `delivery_runs_tenantId_loadLocationId_idx` ON `delivery_runs`(`tenantId`, `loadLocationId`);

-- AddForeignKey
ALTER TABLE `delivery_runs` ADD CONSTRAINT `delivery_runs_loadLocationId_fkey` FOREIGN KEY (`loadLocationId`) REFERENCES `stock_locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
