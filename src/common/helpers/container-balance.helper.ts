import { ContainerMovementType } from '../enums/delivery.enum';

/**
 * Signed contribution toward "cans with this customer".
 * Positive = with customer; negative = returned to plant.
 */
export function customerContainerSignedQty(
  movementType: ContainerMovementType | string,
  quantity: number,
): number {
  switch (movementType) {
    case ContainerMovementType.OPENING_WITH_CUSTOMER:
    case ContainerMovementType.DELIVERED_TO_CUSTOMER:
      return quantity;
    case ContainerMovementType.RETURNED_FROM_CUSTOMER:
      return -quantity;
    case ContainerMovementType.ADJUSTMENT:
      // Customer-scoped adjustments use signed quantity.
      return quantity;
    default:
      return 0;
  }
}

/**
 * Signed contribution toward tenant ownedTotal (fleet baseline pool).
 * Only on-hand / fleet movements (customerId must be null at call site).
 */
export function ownedPoolSignedQty(
  movementType: ContainerMovementType | string,
  quantity: number,
): number {
  switch (movementType) {
    case ContainerMovementType.OPENING_ON_HAND:
      return quantity;
    case ContainerMovementType.ADJUSTMENT:
      return quantity;
    case ContainerMovementType.LOST:
    case ContainerMovementType.DAMAGED:
      return -Math.abs(quantity);
    default:
      return 0;
  }
}
