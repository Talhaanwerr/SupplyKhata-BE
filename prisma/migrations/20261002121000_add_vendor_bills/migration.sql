-- CreateTable
CREATE TABLE `vendor_bills` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NULL,
    `goodsReceiptId` VARCHAR(191) NULL,
    `billNumber` VARCHAR(191) NULL,
    `billDate` DATETIME(3) NOT NULL,
    `dueDate` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `status` ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOID') NOT NULL DEFAULT 'UNPAID',
    `totalAmount` DECIMAL(12, 2) NOT NULL,
    `paidAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `voidReason` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `vendor_bills_tenantId_billNumber_key`(`tenantId`, `billNumber`),
    INDEX `vendor_bills_tenantId_vendorId_idx`(`tenantId`, `vendorId`),
    INDEX `vendor_bills_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `vendor_bills_tenantId_billDate_idx`(`tenantId`, `billDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vendor_bill_lines` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `vendorBillId` VARCHAR(191) NOT NULL,
    `lineNo` INTEGER NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `qty` DECIMAL(12, 3) NOT NULL,
    `unitCost` DECIMAL(12, 2) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `purchaseOrderLineId` VARCHAR(191) NULL,
    `goodsReceiptLineId` VARCHAR(191) NULL,

    INDEX `vendor_bill_lines_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `vendor_bill_lines_vendorBillId_lineNo_key`(`vendorBillId`, `lineNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vendor_bill_payments` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `vendorBillId` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `paymentDate` DATETIME(3) NOT NULL,
    `method` ENUM('CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'OTHER') NOT NULL,
    `reference` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vendor_bill_payments_tenantId_vendorId_idx`(`tenantId`, `vendorId`),
    INDEX `vendor_bill_payments_tenantId_vendorBillId_idx`(`tenantId`, `vendorBillId`),
    INDEX `vendor_bill_payments_tenantId_paymentDate_idx`(`tenantId`, `paymentDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vendor_ledger_entries` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `entryType` ENUM('BILL', 'PAYMENT', 'VOID') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `referenceId` VARCHAR(191) NULL,
    `referenceType` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vendor_ledger_entries_tenantId_vendorId_idx`(`tenantId`, `vendorId`),
    INDEX `vendor_ledger_entries_tenantId_vendorId_createdAt_idx`(`tenantId`, `vendorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `vendor_bills` ADD CONSTRAINT `vendor_bills_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bills` ADD CONSTRAINT `vendor_bills_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bills` ADD CONSTRAINT `vendor_bills_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchase_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bills` ADD CONSTRAINT `vendor_bills_goodsReceiptId_fkey` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goods_receipts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bills` ADD CONSTRAINT `vendor_bills_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_lines` ADD CONSTRAINT `vendor_bill_lines_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_lines` ADD CONSTRAINT `vendor_bill_lines_vendorBillId_fkey` FOREIGN KEY (`vendorBillId`) REFERENCES `vendor_bills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_payments` ADD CONSTRAINT `vendor_bill_payments_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_payments` ADD CONSTRAINT `vendor_bill_payments_vendorBillId_fkey` FOREIGN KEY (`vendorBillId`) REFERENCES `vendor_bills`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_payments` ADD CONSTRAINT `vendor_bill_payments_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_bill_payments` ADD CONSTRAINT `vendor_bill_payments_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_ledger_entries` ADD CONSTRAINT `vendor_ledger_entries_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vendor_ledger_entries` ADD CONSTRAINT `vendor_ledger_entries_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
