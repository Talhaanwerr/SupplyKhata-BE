-- AlterTable
ALTER TABLE `delivery_run_stocks` ADD COLUMN `filledPackagingCount` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `delivery_items` ADD COLUMN `containersDelivered` INTEGER NOT NULL DEFAULT 0;
