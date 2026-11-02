/**
 * Money is whole forints. Nothing here takes or returns a fraction, so no
 * rounding can hide in an intermediate value.
 */
export type Forint = number;

/**
 * Rounds a half away from zero, as the invoicing rules require: 2.5 becomes 3
 * and -2.5 becomes -3. Math.round would give -2, which would make every
 * storno invoice a forint out.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be a whole number of forints, got ${value}`);
  }
}

function assertVatRate(vatRate: number): void {
  if (!Number.isInteger(vatRate) || vatRate < 0 || vatRate > 100) {
    throw new RangeError(`vatRate must be a whole percentage between 0 and 100, got ${vatRate}`);
  }
}

/**
 * The net amount inside a gross one. Computed as gross * 100 / (100 + rate) in
 * whole numbers: dividing by 1.27 in floating point can land a hair either
 * side of a half and round the wrong way.
 */
export function netOfGross(gross: Forint, vatRate: number): Forint {
  assertInteger("gross", gross);
  assertVatRate(vatRate);
  return roundHalfAwayFromZero((gross * 100) / (100 + vatRate));
}

/** The VAT inside a gross amount. Always gross minus net, so the three agree. */
export function vatOfGross(gross: Forint, vatRate: number): Forint {
  return gross - netOfGross(gross, vatRate);
}

/** Just enough of a line to work out its amounts. */
export type AmountsInput = {
  quantity: number;
  unitPriceGross: Forint;
  vatRate: number;
};

export type LineAmounts = {
  lineGross: Forint;
  lineNet: Forint;
  lineVat: Forint;
};

export function lineAmounts({ quantity, unitPriceGross, vatRate }: AmountsInput): LineAmounts {
  assertInteger("quantity", quantity);
  assertInteger("unitPriceGross", unitPriceGross);
  const lineGross = unitPriceGross * quantity;
  const lineNet = netOfGross(lineGross, vatRate);
  return { lineGross, lineNet, lineVat: lineGross - lineNet };
}

export type Totals = {
  totalGross: Forint;
  totalNet: Forint;
  totalVat: Forint;
};

/**
 * Totals are the sums of the line amounts, never recalculated from the gross
 * total: that is what keeps an invoice's lines and its totals consistent, and
 * matches what is reported to NAV.
 */
export function totalsOfLines(lines: readonly LineAmounts[]): Totals {
  return lines.reduce<Totals>(
    (totals, line) => ({
      totalGross: totals.totalGross + line.lineGross,
      totalNet: totals.totalNet + line.lineNet,
      totalVat: totals.totalVat + line.lineVat,
    }),
    { totalGross: 0, totalNet: 0, totalVat: 0 },
  );
}

/** Reverses a line for a storno invoice: the same amounts, negated. */
export function negateLine(line: LineAmounts): LineAmounts {
  return {
    lineGross: -line.lineGross,
    lineNet: -line.lineNet,
    lineVat: -line.lineVat,
  };
}
