-- AlterTable
ALTER TABLE `tenant_settings` ADD COLUMN `allowedDomains` JSON NOT NULL DEFAULT ('[]');
