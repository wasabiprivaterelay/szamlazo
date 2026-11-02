import { test } from "vitest";
import assert from "node:assert/strict";
import { invoiceDataBase64, invoiceDataXml, type NavInvoice } from "../src/invoice-xml.js";

/**
 * Every expectation below is something NAV's test system taught us by
 * refusing an invoice, with the error code it refused it with in the comment.
 */

const supplier = {
  name: "Minta Bt.",
  taxpayerId: "12345678",
  vatCode: "2",
  countyCode: "40",
  postalCode: "1011",
  city: "Budapest",
  address: "Fő utca 1.",
  bankAccount: "11773016-11111111-00000000",
};

const line = {
  description: "Gyapjú sál",
  quantity: 2,
  unitOfMeasure: "PIECE",
  unitPriceNet: 1653.5,
  netAmount: 3307,
  vatAmount: 893,
  grossAmount: 4200,
  vatRate: 27,
};

const invoice: NavInvoice = {
  invoiceNumber: "SZ2026/00001",
  issueDate: "2026-09-22",
  deliveryDate: "2026-09-22",
  paymentDate: "2026-09-22",
  paymentMethod: "TRANSFER",
  supplier,
  customer: { name: "Teszt Vevő", postalCode: "9021", city: "Győr", address: "Teszt utca 1." },
  customerVatStatus: "PRIVATE_PERSON",
  lines: [line],
  vatSummary: [{ vatRate: 27, net: 3307, vat: 893 }],
  totalNet: 3307,
  totalVat: 893,
  totalGross: 4200,
};

test("an address is in the base namespace, not the data one", () => {
  // SCHEMA_VIOLATION: unexpected element (uri: .../data, local: simpleAddress)
  const xml = invoiceDataXml(invoice);
  assert.match(xml, /<base:simpleAddress><base:countryCode>HU<\/base:countryCode>/);
  assert.doesNotMatch(xml, /data:simpleAddress/);
  assert.match(xml, /<base:additionalAddressDetail>Fő utca 1\.<\/base:additionalAddressDetail>/);
});

test("a private buyer's name and address are not reported at all", () => {
  // CUSTOMER_DATA_NOT_EXPECTED: Magánszemély vevő adatai nem adhatóak meg.
  const xml = invoiceDataXml(invoice);
  assert.match(xml, /<data:customerVatStatus>PRIVATE_PERSON<\/data:customerVatStatus>/);
  assert.doesNotMatch(xml, /Teszt Vevő/);
  assert.doesNotMatch(xml, /Győr/);
  // The invoice the customer receives still carries them; this is the report.
  assert.match(xml, /<data:customerInfo><data:customerVatStatus>/);
});

test("a company buyer is reported with its name, address and tax number", () => {
  const xml = invoiceDataXml({
    ...invoice,
    customerVatStatus: "DOMESTIC",
    customer: {
      name: "Példa Kft.",
      taxpayerId: "10770755",
      vatCode: "2",
      countyCode: "44",
      postalCode: "1117",
      city: "Budapest",
      address: "Teszt körút 2.",
    },
  });
  assert.match(xml, /<data:customerName>Példa Kft\.<\/data:customerName>/);
  assert.match(xml, /<data:customerVatData><data:customerTaxNumber><base:taxpayerId>10770755/);
});

test("a rate is a fraction and money has two decimals", () => {
  const xml = invoiceDataXml(invoice);
  // RateType is between 0 and 1: 27% is 0.27, not 27.
  assert.match(xml, /<data:vatPercentage>0\.27<\/data:vatPercentage>/);
  assert.match(xml, /<data:lineNetAmount>3307\.00<\/data:lineNetAmount>/);
  // The unit price keeps its fillér, as the invoice does.
  assert.match(xml, /<data:unitPrice>1653\.50<\/data:unitPrice>/);
  // Forint amounts are stated twice; for a forint invoice they are equal.
  assert.match(xml, /<data:lineNetAmountHUF>3307\.00<\/data:lineNetAmountHUF>/);
  assert.match(xml, /<data:exchangeRate>1<\/data:exchangeRate>/);
});

test("a storno references the original and says which correction it is", () => {
  // Without modificationIndex: SCHEMA_VIOLATION, the reference is incomplete.
  const xml = invoiceDataXml({
    ...invoice,
    invoiceNumber: "SZ2026/00002",
    reverses: "SZ2026/00001",
    lines: [{ ...line, quantity: -2, netAmount: -3307, vatAmount: -893, grossAmount: -4200, lineNumber: 1, modifies: { lineNumberReference: 2, operation: "CREATE" } }],
    vatSummary: [{ vatRate: 27, net: -3307, vat: -893 }],
    totalNet: -3307,
    totalVat: -893,
    totalGross: -4200,
  });
  assert.match(xml, /<data:originalInvoiceNumber>SZ2026\/00001<\/data:originalInvoiceNumber>/);
  assert.match(xml, /<data:modifyWithoutMaster>false<\/data:modifyWithoutMaster>/);
  assert.match(xml, /<data:modificationIndex>1<\/data:modificationIndex>/);
  // LINE_MODIFICATION_EXPECTED without this block.
  assert.match(xml, /<data:lineModificationReference>/);
  // lineNumber is the place in this document; lineNumberReference is the new
  // number in the chain. Swapping them earns LINE_NUMBER_NOT_SEQUENTIAL and
  // INVOICE_LINE_ALREADY_EXISTS together.
  assert.match(xml, /<data:lineNumber>1<\/data:lineNumber>/);
  assert.match(xml, /<data:lineNumberReference>2<\/data:lineNumberReference>/);
  assert.match(xml, /<data:lineOperation>CREATE<\/data:lineOperation>/);
  assert.match(xml, /<data:lineNetAmount>-3307\.00<\/data:lineNetAmount>/);
});

test("the elements come in the order the schema fixes", () => {
  const xml = invoiceDataXml(invoice);
  const order = [
    "data:invoiceNumber",
    "data:invoiceIssueDate",
    "data:completenessIndicator",
    "data:supplierInfo",
    "data:customerInfo",
    "data:invoiceDetail",
    "data:invoiceLines",
    "data:invoiceSummary",
  ].map((name) => xml.indexOf(`<${name}`));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "the schema is a sequence, so the order is part of being valid",
  );
});

test("what is sent is the XML, base64 encoded", () => {
  const encoded = invoiceDataBase64(invoice);
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), invoiceDataXml(invoice));
});

test("a line without VAT reports why: exemption, out of scope, or reverse charge", () => {
  const exempt = (vatExemption: NonNullable<NavInvoice["lines"][number]["vatExemption"]>) => {
    const zero = { ...line, vatRate: 0, vatAmount: 0, netAmount: 4200, unitPriceNet: 2100, vatExemption };
    return invoiceDataXml({
      ...invoice,
      lines: [zero],
      vatSummary: [{ vatRate: 0, vatExemption, net: 4200, vat: 0 }],
      totalNet: 4200,
      totalVat: 0,
    });
  };

  const tam = exempt({ case: "TAM", reason: "Áfa tv. 85. § (1) e)" });
  assert.match(tam, /<data:lineVatRate><data:vatExemption><data:case>TAM<\/data:case><data:reason>Áfa tv\. 85\. § \(1\) e\)<\/data:reason><\/data:vatExemption><\/data:lineVatRate>/);
  assert.match(tam, /<data:vatRate><data:vatExemption><data:case>TAM<\/data:case>/, "the summary row says the same");
  assert.doesNotMatch(tam, /vatPercentage/);

  assert.match(exempt({ case: "AAM", reason: "Alanyi adómentes" }), /<data:vatExemption><data:case>AAM<\/data:case>/);
  assert.match(exempt({ case: "ATK", reason: "Hatályon kívüli" }), /<data:vatOutOfScope><data:case>ATK<\/data:case><data:reason>Hatályon kívüli<\/data:reason><\/data:vatOutOfScope>/);
  assert.match(exempt({ case: "REVERSE_CHARGE", reason: "Fordított adózás" }), /<data:lineVatRate><data:vatDomesticReverseCharge>true<\/data:vatDomesticReverseCharge><\/data:lineVatRate>/);
});

test("an exemption on a line that has a VAT rate is a mistake, not a report", () => {
  assert.throws(
    () => invoiceDataXml({ ...invoice, lines: [{ ...line, vatExemption: { case: "TAM", reason: "x" } }] }),
    /vatRate 0/,
  );
});
