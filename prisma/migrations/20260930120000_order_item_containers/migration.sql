-- Order line packaging / empties (returnable-containers on orders)
ALTER TABLE `order_items` ADD COLUMN `containersDelivered` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `order_items` ADD COLUMN `emptiesReceived` INTEGER NOT NULL DEFAULT 0;
