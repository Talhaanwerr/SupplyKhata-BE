-- AlterTable
ALTER TABLE `customers` ADD COLUMN `billingAnchorDate` DATETIME(3) NULL;

-- Backfill WEEKLY / FORTNIGHTLY: use createdAt date as billing anchor
UPDATE `customers`
SET `billingAnchorDate` = DATE(`createdAt`)
WHERE `paymentCycle` IN ('WEEKLY', 'FORTNIGHTLY')
  AND `billingAnchorDate` IS NULL
  AND `deletedAt` IS NULL;
