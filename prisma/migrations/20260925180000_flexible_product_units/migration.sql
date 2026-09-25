-- Flexible product units: baseUnit / pack helper / decimal qty + opening stock

ALTER TABLE `products`
  ADD COLUMN `baseUnit` ENUM('PCS', 'LTR', 'KG') NOT NULL DEFAULT 'PCS',
  ADD COLUMN `unitsPerPack` INTEGER NULL,
  ADD COLUMN `packLabel` VARCHAR(191) NULL,
  ADD COLUMN `containerCapacity` DECIMAL(10, 2) NULL,
  ADD COLUMN `allowFractionalQty` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `delivery_items`
  MODIFY `quantityDelivered` DECIMAL(12, 3) NOT NULL,
  MODIFY `lineTotal` DECIMAL(12, 2) NOT NULL;

ALTER TABLE `delivery_run_stocks`
  MODIFY `filledCount` DECIMAL(12, 3) NOT NULL DEFAULT 0;
