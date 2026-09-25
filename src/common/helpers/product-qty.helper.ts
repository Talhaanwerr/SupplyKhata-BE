import { BadRequestException } from '@nestjs/common';

/** Max 3 decimal places for fractional base-unit quantities. */
const QTY_DECIMALS = 3;
const QTY_SCALE = 10 ** QTY_DECIMALS;

export function assertValidBaseQuantity(
  qty: number,
  product: { name: string; allowFractionalQty: boolean },
): void {
  if (!Number.isFinite(qty) || qty < 0) {
    throw new BadRequestException(`Invalid quantity for "${product.name}"`);
  }
  if (!product.allowFractionalQty) {
    if (!Number.isInteger(qty)) {
      throw new BadRequestException(
        `"${product.name}" does not allow fractional quantity — enter a whole number`,
      );
    }
    return;
  }
  const scaled = qty * QTY_SCALE;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new BadRequestException(
      `"${product.name}" quantity can have at most ${QTY_DECIMALS} decimal places`,
    );
  }
}

export function assertValidStockQuantity(
  qty: number,
  product: { name: string; allowFractionalQty: boolean },
  fieldLabel: string,
): void {
  if (!Number.isFinite(qty) || qty < 0) {
    throw new BadRequestException(`Invalid ${fieldLabel} for "${product.name}"`);
  }
  if (!product.allowFractionalQty && !Number.isInteger(qty)) {
    throw new BadRequestException(`"${product.name}" ${fieldLabel} must be a whole number`);
  }
  if (product.allowFractionalQty) {
    const scaled = qty * QTY_SCALE;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      throw new BadRequestException(
        `"${product.name}" ${fieldLabel} can have at most ${QTY_DECIMALS} decimal places`,
      );
    }
  }
}

export function decimalQtyToNumber(
  value: { toString(): string } | number | null | undefined,
): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return Number(value.toString());
}

/** Pack helper: both set or both null; unitsPerPack >= 2 when set. */
export function normalizePackFields(input: {
  unitsPerPack?: number | null;
  packLabel?: string | null;
}): { unitsPerPack: number | null; packLabel: string | null } {
  const units =
    input.unitsPerPack === undefined || input.unitsPerPack === null
      ? null
      : Number(input.unitsPerPack);
  const label =
    input.packLabel === undefined ||
    input.packLabel === null ||
    String(input.packLabel).trim() === ''
      ? null
      : String(input.packLabel).trim();

  if (units == null && label == null) {
    return { unitsPerPack: null, packLabel: null };
  }
  if (units == null || label == null) {
    throw new BadRequestException('Pack label and units per pack must be set together');
  }
  if (!Number.isInteger(units) || units < 2) {
    throw new BadRequestException('Units per pack must be a whole number ≥ 2');
  }
  return { unitsPerPack: units, packLabel: label };
}
