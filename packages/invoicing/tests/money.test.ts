import { test, expect } from "vitest";
import assert from "node:assert/strict";
import {
  roundHalfAwayFromZero,
  netOfGross,
  vatOfGross,
  lineAmounts,
  totalsOfLines,
  negateLine,
} from "../src/money.js";

test("a half rounds away from zero in both directions", () => {
  assert.equal(roundHalfAwayFromZero(2.5), 3);
  assert.equal(roundHalfAwayFromZero(-2.5), -3);
  assert.equal(roundHalfAwayFromZero(2.4), 2);
  assert.equal(roundHalfAwayFromZero(-2.4), -2);
  // What Math.round would get wrong, and every storno invoice depends on.
  assert.notEqual(roundHalfAwayFromZero(-2.5), Math.round(-2.5));
});

test("net and VAT add back up to the gross price, for every product price", () => {
  for (const gross of [2100, 2400, 2700, 3000, 3500]) {
    assert.equal(netOfGross(gross, 27) + vatOfGross(gross, 27), gross);
  }
});

test("the 27% split is right for the current prices", () => {
  // 2100 / 1.27 = 1653.54..., so net 1654 and VAT 446.
  assert.deepEqual([netOfGross(2100, 27), vatOfGross(2100, 27)], [1654, 446]);
  assert.deepEqual([netOfGross(3000, 27), vatOfGross(3000, 27)], [2362, 638]);
});

test("net and VAT add back up at every rate and amount", () => {
  for (const vatRate of [0, 5, 18, 27]) {
    for (let gross = 0; gross <= 5000; gross += 7) {
      assert.equal(
        netOfGross(gross, vatRate) + vatOfGross(gross, vatRate),
        gross,
        `${gross} at ${vatRate}%`,
      );
    }
  }
});

test("zero VAT leaves the whole amount as net", () => {
  assert.equal(netOfGross(2100, 0), 2100);
  assert.equal(vatOfGross(2100, 0), 0);
});

test("the split lands on the right side of a half", () => {
  // 127 * 100 / 127 is exactly 100: a decimal division can land at 99.999...
  assert.equal(netOfGross(127, 27), 100);
  assert.equal(netOfGross(254, 27), 200);
});

test("a line multiplies before it splits", () => {
  const line = lineAmounts({ quantity: 3, unitPriceGross: 2100, vatRate: 27 });
  assert.deepEqual(line, { lineGross: 6300, lineNet: 4961, lineVat: 1339 });
  // Splitting each unit and multiplying would give 4962: one forint out.
  assert.notEqual(line.lineNet, netOfGross(2100, 27) * 3);
});

test("totals are the sums of the lines, not a fresh split of the total", () => {
  const lines = [
    lineAmounts({ quantity: 1, unitPriceGross: 2100, vatRate: 27 }),
    lineAmounts({ quantity: 2, unitPriceGross: 2700, vatRate: 27 }),
  ];
  const totals = totalsOfLines(lines);
  assert.equal(totals.totalGross, 7500);
  assert.equal(totals.totalNet, lines[0]!.lineNet + lines[1]!.lineNet);
  assert.equal(totals.totalVat, lines[0]!.lineVat + lines[1]!.lineVat);
  assert.equal(totals.totalNet + totals.totalVat, totals.totalGross);
});

test("totals keep adding up with mixed VAT rates", () => {
  const lines = [
    lineAmounts({ quantity: 1, unitPriceGross: 2100, vatRate: 27 }),
    lineAmounts({ quantity: 1, unitPriceGross: 1000, vatRate: 5 }),
  ];
  const totals = totalsOfLines(lines);
  assert.equal(totals.totalNet + totals.totalVat, totals.totalGross);
});

test("an empty invoice totals zero", () => {
  assert.deepEqual(totalsOfLines([]), { totalGross: 0, totalNet: 0, totalVat: 0 });
});

test("a storno line is the original negated, and the two cancel out", () => {
  const line = lineAmounts({ quantity: 2, unitPriceGross: 2400, vatRate: 27 });
  const storno = negateLine(line);
  assert.deepEqual(storno, { lineGross: -4800, lineNet: -3780, lineVat: -1020 });
  assert.deepEqual(totalsOfLines([line, storno]), {
    totalGross: 0,
    totalNet: 0,
    totalVat: 0,
  });
});

test("fractional money is refused rather than rounded quietly", () => {
  expect(() => netOfGross(2100.5, 27)).toThrow(/whole number/);
  expect(() => lineAmounts({ quantity: 1.5, unitPriceGross: 2100, vatRate: 27 })).toThrow(
    /whole number/,
  );
});

test("an impossible VAT rate is refused", () => {
  for (const vatRate of [-1, 101, 27.5]) {
    expect(() => netOfGross(2100, vatRate)).toThrow(/vatRate/);
  }
});
