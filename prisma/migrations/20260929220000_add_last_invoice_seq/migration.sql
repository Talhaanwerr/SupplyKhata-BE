-- Invoice numbering sequence on tenant settings
ALTER TABLE `tenant_settings` ADD COLUMN `lastInvoiceSeq` INTEGER NOT NULL DEFAULT 0;
