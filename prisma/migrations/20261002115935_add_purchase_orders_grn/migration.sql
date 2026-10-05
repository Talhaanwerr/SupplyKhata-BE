-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `poNumber` VARCHAR(191) NULL,
    `expectedDate` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `cancelReason` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `purchase_orders_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `purchase_orders_tenantId_vendorId_idx`(`tenantId`, `vendorId`),
    INDEX `purchase_orders_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    UNIQUE INDEX `purchase_orders_tenantId_poNumber_key`(`tenantId`, `poNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_order_lines` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `lineNo` INTEGER NOT NULL,
    `rawMaterialId` VARCHAR(191) NULL,
    `productId` VARCHAR(191) NULL,
    `qtyOrdered` DECIMAL(12, 3) NOT NULL,
    `unitCost` DECIMAL(12, 2) NOT NULL,
    `qtyReceived` DECIMAL(12, 3) NOT NULL DEFAULT 0,

    INDEX `purchase_order_lines_tenantId_idx`(`tenantId`),
    INDEX `purchase_order_lines_tenantId_purchaseOrderId_idx`(`tenantId`, `purchaseOrderId`),
    UNIQUE INDEX `purchase_order_lines_purchaseOrderId_lineNo_key`(`purchaseOrderId`, `lineNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipts` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `receiptDate` DATETIME(3) NOT NULL,
    `notes` TEXT NULL,
    `receivedByUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `goods_receipts_tenantId_purchaseOrderId_idx`(`tenantId`, `purchaseOrderId`),
    INDEX `goods_receipts_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_lines` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `goodsReceiptId` VARCHAR(191) NOT NULL,
    `purchaseOrderLineId` VARCHAR(191) NOT NULL,
    `qtyReceived` DECIMAL(12, 3) NOT NULL,

    INDEX `goods_receipt_lines_tenantId_idx`(`tenantId`),
    INDEX `goods_receipt_lines_tenantId_goodsReceiptId_idx`(`tenantId`, `goodsReceiptId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_rawMaterialId_fkey` FOREIGN KEY (`rawMaterialId`) REFERENCES `raw_materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchase_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `stock_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_receivedByUserId_fkey` FOREIGN KEY (`receivedByUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_lines` ADD CONSTRAINT `goods_receipt_lines_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_lines` ADD CONSTRAINT `goods_receipt_lines_goodsReceiptId_fkey` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goods_receipts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_lines` ADD CONSTRAINT `goods_receipt_lines_purchaseOrderLineId_fkey` FOREIGN KEY (`purchaseOrderLineId`) REFERENCES `purchase_order_lines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
