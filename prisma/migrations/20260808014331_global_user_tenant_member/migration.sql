/*
  Warnings:

  - You are about to drop the column `invitedById` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE `user_sessions` DROP FOREIGN KEY `user_sessions_tenantId_fkey`;

-- DropForeignKey
ALTER TABLE `users` DROP FOREIGN KEY `users_tenantId_fkey`;

-- DropIndex
DROP INDEX `users_tenantId_createdAt_idx` ON `users`;

-- DropIndex
DROP INDEX `users_tenantId_email_key` ON `users`;

-- DropIndex
DROP INDEX `users_tenantId_status_idx` ON `users`;

-- AlterTable
ALTER TABLE `user_sessions` MODIFY `tenantId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `users` DROP COLUMN `invitedById`,
    DROP COLUMN `status`,
    DROP COLUMN `tenantId`;

-- CreateTable
CREATE TABLE `tenant_members` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'INVITED',
    `invitedById` VARCHAR(191) NULL,
    `joinedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tenant_members_tenantId_idx`(`tenantId`),
    INDEX `tenant_members_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `tenant_members_userId_tenantId_key`(`userId`, `tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `users_email_key` ON `users`(`email`);

-- CreateIndex
CREATE INDEX `users_email_idx` ON `users`(`email`);

-- AddForeignKey
ALTER TABLE `tenant_members` ADD CONSTRAINT `tenant_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenant_members` ADD CONSTRAINT `tenant_members_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
