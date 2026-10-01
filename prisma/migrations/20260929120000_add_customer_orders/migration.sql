-- Orders module (standalone — no DeliveryRun FKs)
-- Also extends LedgerEntryType with ORDER_SALE

ALTER TABLE `customer_ledger_entries` MODIFY `entryType` ENUM(
  'DELIVERY_SALE',
  'PAYMENT',
  'ADJUSTMENT',
  'OPENING_BALANCE',
  'REFUND',
  'ORDER_SALE'
) NOT NULL;

CREATE TABLE `customer_orders` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT', 'PLACED', 'SHIPPED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'DRAFT',
  `paymentStatus` ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID') NOT NULL DEFAULT 'UNPAID',
  `orderNumber` INTEGER NOT NULL,
  `subtotal` DECIMAL(10, 2) NOT NULL,
  `discountTotal` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `deliveryCharges` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(10, 2) NOT NULL,
  `amountPaid` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `amountDue` DECIMAL(10, 2) NOT NULL,
  `shippingAddress` TEXT NULL,
  `shippingNotes` TEXT NULL,
  `internalNotes` TEXT NULL,
  `preferredShipDate` DATE NULL,
  `cancelReason` VARCHAR(191) NULL,
  `cancelledAt` DATETIME(3) NULL,
  `cancelledById` VARCHAR(191) NULL,
  `refundReason` VARCHAR(191) NULL,
  `refundedAt` DATETIME(3) NULL,
  `refundedById` VARCHAR(191) NULL,
  `refundAmount` DECIMAL(10, 2) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `customer_orders_tenantId_orderNumber_key`(`tenantId`, `orderNumber`),
  INDEX `customer_orders_tenantId_status_idx`(`tenantId`, `status`),
  INDEX `customer_orders_tenantId_paymentStatus_idx`(`tenantId`, `paymentStatus`),
  INDEX `customer_orders_tenantId_customerId_idx`(`tenantId`, `customerId`),
  INDEX `customer_orders_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
  CONSTRAINT `customer_orders_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `customer_orders_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `customer_orders_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `customer_orders_cancelledById_fkey` FOREIGN KEY (`cancelledById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `customer_orders_refundedById_fkey` FOREIGN KEY (`refundedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_items` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `quantity` DECIMAL(12, 3) NOT NULL,
  `quantityDelivered` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `unitPriceSnapshot` DECIMAL(10, 2) NOT NULL,
  `costSnapshot` DECIMAL(10, 2) NULL,
  `lineDiscount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `lineTotal` DECIMAL(10, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `order_items_tenantId_orderId_idx`(`tenantId`, `orderId`),
  INDEX `order_items_tenantId_productId_idx`(`tenantId`, `productId`),
  CONSTRAINT `order_items_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `customer_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_payments` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `paymentId` VARCHAR(191) NULL,
  `method` ENUM('CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'OTHER') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `paidAt` DATETIME(3) NOT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `order_payments_tenantId_orderId_idx`(`tenantId`, `orderId`),
  CONSTRAINT `order_payments_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `order_payments_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `customer_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_payments_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_status_events` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `fromStatus` ENUM('DRAFT', 'PLACED', 'SHIPPED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED', 'REFUNDED') NULL,
  `toStatus` ENUM('DRAFT', 'PLACED', 'SHIPPED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED', 'REFUNDED') NOT NULL,
  `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `byId` VARCHAR(191) NULL,
  `note` VARCHAR(191) NULL,

  PRIMARY KEY (`id`),
  INDEX `order_status_events_tenantId_orderId_idx`(`tenantId`, `orderId`),
  INDEX `order_status_events_tenantId_orderId_at_idx`(`tenantId`, `orderId`, `at`),
  CONSTRAINT `order_status_events_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `order_status_events_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `customer_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_status_events_byId_fkey` FOREIGN KEY (`byId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
