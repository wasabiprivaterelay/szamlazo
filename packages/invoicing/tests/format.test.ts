import { test } from "vitest";
import assert from "node:assert/strict";
import {
  formatAmount,
  formatDateHu,
  formatMoney,
  formatTaxNumber,
  formatUnitAmount,
  formatUnitMoney,
  paymentMethodLabel,
  yearOf,
} from "../src/format.js";

const THIN = " ";
const MINUS = "−";

test("amounts are grouped the way Hungarian groups them", () => {
  assert.equal(formatAmount(0), "0");
  assert.equal(formatAmount(890), "890");
  // Four digits take no separator in Hungarian; five and up take one, which
  // is what Intl does for hu-HU and so what the shop's pages show.
  assert.equal(formatAmount(8890), "8890");
  assert.equal(formatAmount(10000), `10${THIN}000`);
  assert.equal(formatAmount(1234567), `1${THIN}234${THIN}567`);
});

test("a negative amount takes a minus sign, not a hyphen", () => {
  assert.equal(formatAmount(-4200), `${MINUS}4200`);
  assert.equal(formatAmount(-42000), `${MINUS}42${THIN}000`);
  assert.equal(formatMoney(-4200, "HUF"), `${MINUS}4200 Ft`);
});

test("money is labelled by its currency", () => {
  assert.equal(formatMoney(2100, "HUF"), "2100 Ft");
  assert.equal(formatMoney(2100, "EUR"), "2100 EUR");
  assert.equal(formatMoney(21000, "HUF"), `21${THIN}000 Ft`);
});

test("a unit price keeps its fillér, so quantity times unit gives the line", () => {
  // 3307 net over two items is 1653,50 each; printed rounded, a reader
  // multiplying it out would find a forint missing.
  assert.equal(formatUnitAmount(3307 / 2), "1653,50");
  assert.equal(formatUnitAmount(2126), "2126");
  assert.equal(formatUnitAmount(-3307 / 2), `${MINUS}1653,50`);
  assert.equal(formatUnitAmount(1653.505), "1653,51");
  assert.equal(formatUnitMoney(3307 / 2, "HUF"), "1653,50 Ft");
  assert.equal(formatUnitAmount(12345.5), `12${THIN}345,50`);
});

test("a quantity of two thirds of a unit still prints", () => {
  assert.equal(formatUnitAmount(0.5), "0,50");
});

test("dates are the calendar day, in UTC", () => {
  assert.equal(formatDateHu(new Date("2026-09-22")), "2026.09.22.");
  assert.equal(formatDateHu(new Date("2026-01-02T23:30:00Z")), "2026.01.02.");
  assert.equal(yearOf(new Date("2026-12-31T22:30:00Z")), 2026);
});

test("a tax number prints in its three parts", () => {
  assert.equal(formatTaxNumber("12345678241"), "12345678-2-41");
  assert.equal(formatTaxNumber("12345678-2-41"), "12345678-2-41");
  // Anything that is not eleven digits is left exactly as given.
  assert.equal(formatTaxNumber("HU12345678"), "HU12345678");
});

test("payment methods are named in Hungarian", () => {
  assert.equal(paymentMethodLabel("card"), "Bankkártya");
  assert.equal(paymentMethodLabel("transfer"), "Átutalás");
  assert.equal(paymentMethodLabel("cash"), "Készpénz");
});
