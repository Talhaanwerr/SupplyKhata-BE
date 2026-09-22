-- AlterTable
ALTER TABLE `customers`
  ADD COLUMN `promisedDueDate` DATETIME(3) NULL,
  ADD COLUMN `promisedDueAmount` DECIMAL(10, 2) NULL,
  ADD COLUMN `promisedDueDeliveryId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `deliveries`
  ADD COLUMN `promisedPayDate` DATETIME(3) NULL,
  ADD COLUMN `promisedAmount` DECIMAL(10, 2) NULL;

-- CreateIndex
CREATE INDEX `customers_tenantId_promisedDueDate_idx` ON `customers`(`tenantId`, `promisedDueDate`);

-- AddForeignKey
ALTER TABLE `customers`
  ADD CONSTRAINT `customers_promisedDueDeliveryId_fkey`
  FOREIGN KEY (`promisedDueDeliveryId`) REFERENCES `deliveries`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
