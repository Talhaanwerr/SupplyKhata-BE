-- Raw material cost history (mirrors product_cost_history)
-- Index names shortened for MySQL 64-char identifier limit.
CREATE TABLE `raw_material_cost_history` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `rawMaterialId` VARCHAR(191) NOT NULL,
    `costPerUnit` DECIMAL(12, 2) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `notes` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rm_cost_hist_tenant_rm_idx`(`tenantId`, `rawMaterialId`),
    INDEX `rm_cost_hist_tenant_rm_eff_idx`(`tenantId`, `rawMaterialId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `raw_material_cost_history` ADD CONSTRAINT `raw_material_cost_history_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
