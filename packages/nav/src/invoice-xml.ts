import { element, optional, writeXml, type XmlNode } from "./xml.js";
import { DATA_NS } from "./request.js";

/**
 * An invoice as invoiceData.xsd wants it. The shapes here are the schema's,
 * not ours: element order is fixed, money carries two decimals, a VAT rate is
 * a fraction between 0 and 1, and every amount is given twice — once in the
 * invoice's currency and once in forints, which for a forint invoice are the
 * same number.
 */

export type NavParty = {
  name: string;
  /** The first eight digits, without the VAT and county parts. */
  taxpayerId?: string;
  /** The ninth digit of a Hungarian tax number. */
  vatCode?: string;
  /** The last two digits. */
  countyCode?: string;
  countryCode?: string;
  postalCode: string;
  city: string;
  /** Street and number, on one line, which is what simpleAddress takes. */
  address: string;
  bankAccount?: string;
};

export type NavLine = {
  description: string;
  /** Its position in this document, counting from 1. */
  lineNumber?: number;
  /**
   * On a storno or a modification, how this line sits in the invoice's chain.
   * Two rules that look alike and are not (specification 2.5.1): lineNumber
   * is this line's place in this document, counting from 1, while
   * lineNumberReference is its new number in the chain, continuing after the
   * original's lines and any earlier corrections. Reversing a one-line
   * invoice therefore gives lineNumber 1 and lineNumberReference 2, with
   * CREATE. Getting them the other way round earns
   * LINE_NUMBER_NOT_SEQUENTIAL and INVOICE_LINE_ALREADY_EXISTS at once.
   */
  modifies?: { lineNumberReference: number; operation: "CREATE" | "MODIFY" };
  quantity: number;
  /** PIECE, LITER, KILOGRAM… or OWN with unitOfMeasureOwn beside it. */
  unitOfMeasure: string;
  unitOfMeasureOwn?: string;
  /** Net, and it may have fillér: 3307 over two items is 1653.50. */
  unitPriceNet: number;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  /** 27 for the standard Hungarian rate, not 0.27. 0 with vatExemption. */
  vatRate: number;
  vatExemption?: NavVatExemption;
};

/**
 * A line without VAT, and why. AAM and TAM are reported as vatExemption, ATK
 * as vatOutOfScope, REVERSE_CHARGE as vatDomesticReverseCharge; the reason is
 * the legal reference printed on the invoice (at most 200 characters).
 */
export type NavVatExemption = {
  case: "AAM" | "TAM" | "ATK" | "REVERSE_CHARGE";
  reason: string;
};

export type NavVatSummary = {
  vatRate: number;
  vatExemption?: NavVatExemption;
  net: number;
  vat: number;
};

export type NavInvoice = {
  invoiceNumber: string;
  /** yyyy-mm-dd. */
  issueDate: string;
  /** The day the sale was fulfilled; for a prepaid order, the day paid. */
  deliveryDate: string;
  paymentDate?: string;
  paymentMethod: "TRANSFER" | "CASH" | "CARD" | "VOUCHER" | "OTHER";
  currency?: string;
  supplier: NavParty;
  customer: NavParty;
  /** PRIVATE_PERSON for someone buying for themselves. */
  customerVatStatus: "DOMESTIC" | "OTHER" | "PRIVATE_PERSON";
  lines: readonly NavLine[];
  vatSummary: readonly NavVatSummary[];
  totalNet: number;
  totalVat: number;
  totalGross: number;
  /** The invoice this one reverses, when it is a storno. */
  reverses?: string;
  /** Which correction this is of that invoice; the first is 1. */
  modificationIndex?: number;
};

/** Two decimals, which is what MonetaryType allows. */
function money(amount: number): string {
  return amount.toFixed(2);
}

/** A rate is a fraction here: 27% is 0.27, to at most four decimals. */
function rate(percentage: number): string {
  return (percentage / 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function quantity(value: number): string {
  return String(value);
}

/**
 * An address sits in the base namespace, not the data one: AddressType is
 * defined in invoiceBase.xsd, and its children belong to the schema that
 * declares them. NAV says so plainly when it is wrong — "unexpected element
 * (uri: .../data, local: simpleAddress)".
 */
function addressNode(name: string, party: NavParty): XmlNode {
  return element(name, [
    element("base:simpleAddress", [
      element("base:countryCode", party.countryCode ?? "HU"),
      element("base:postalCode", party.postalCode),
      element("base:city", party.city),
      element("base:additionalAddressDetail", party.address),
    ]),
  ]);
}

function taxNumberNode(name: string, party: NavParty): XmlNode | undefined {
  if (!party.taxpayerId) return undefined;
  return element(
    name,
    optional([
      element("base:taxpayerId", party.taxpayerId),
      party.vatCode ? element("base:vatCode", party.vatCode) : undefined,
      party.countyCode ? element("base:countyCode", party.countyCode) : undefined,
    ]),
  );
}

function supplierNode(invoice: NavInvoice): XmlNode {
  const supplier = invoice.supplier;
  const taxNumber = taxNumberNode("data:supplierTaxNumber", supplier);
  if (!taxNumber) throw new Error("the supplier's tax number is what NAV files the invoice under");
  return element(
    "data:supplierInfo",
    optional([
      taxNumber,
      element("data:supplierName", supplier.name),
      addressNode("data:supplierAddress", supplier),
      supplier.bankAccount
        ? element("data:supplierBankAccountNumber", supplier.bankAccount)
        : undefined,
    ]),
  );
}

/**
 * Who the invoice was made out to — except when they are a private person,
 * where NAV refuses the name and the address outright:
 * "CUSTOMER_DATA_NOT_EXPECTED: Magánszemély vevő adatai nem adhatóak meg."
 * The invoice itself still carries them, as the law requires; what is
 * reported is only that the buyer was a private individual.
 */
function customerNode(invoice: NavInvoice): XmlNode {
  if (invoice.customerVatStatus === "PRIVATE_PERSON") {
    return element("data:customerInfo", [
      element("data:customerVatStatus", invoice.customerVatStatus),
    ]);
  }

  const customer = invoice.customer;
  const taxNumber = taxNumberNode("data:customerTaxNumber", customer);
  return element(
    "data:customerInfo",
    optional([
      element("data:customerVatStatus", invoice.customerVatStatus),
      taxNumber ? element("data:customerVatData", [taxNumber]) : undefined,
      element("data:customerName", customer.name),
      addressNode("data:customerAddress", customer),
    ]),
  );
}

/** The VatRateType choice: a percentage, or the reason there is none. */
function vatRateContent(row: { vatRate: number; vatExemption?: NavVatExemption }): XmlNode {
  const exemption = row.vatExemption;
  if (!exemption) return element("data:vatPercentage", rate(row.vatRate));
  if (row.vatRate !== 0) throw new Error(`a line with a VAT exemption must have vatRate 0, not ${row.vatRate}`);
  switch (exemption.case) {
    case "AAM":
    case "TAM":
      return element("data:vatExemption", [element("data:case", exemption.case), element("data:reason", exemption.reason)]);
    case "ATK":
      return element("data:vatOutOfScope", [element("data:case", "ATK"), element("data:reason", exemption.reason)]);
    case "REVERSE_CHARGE":
      return element("data:vatDomesticReverseCharge", "true");
    default:
      throw new Error(`unknown VAT exemption case: ${String((exemption as { case: unknown }).case)}`);
  }
}

function lineNode(line: NavLine, index: number): XmlNode {
  return element(
    "data:line",
    optional([
      element("data:lineNumber", String(line.lineNumber ?? index + 1)),
      line.modifies
        ? element("data:lineModificationReference", [
            element("data:lineNumberReference", String(line.modifies.lineNumberReference)),
            element("data:lineOperation", line.modifies.operation),
          ])
        : undefined,
      // True because the quantity and the unit are stated, which is what this
      // indicator declares.
      element("data:lineExpressionIndicator", "true"),
      element("data:lineDescription", line.description),
      element("data:quantity", quantity(line.quantity)),
      element("data:unitOfMeasure", line.unitOfMeasure),
      line.unitOfMeasureOwn ? element("data:unitOfMeasureOwn", line.unitOfMeasureOwn) : undefined,
      element("data:unitPrice", money(line.unitPriceNet)),
      element("data:lineAmountsNormal", [
        element("data:lineNetAmountData", [
          element("data:lineNetAmount", money(line.netAmount)),
          element("data:lineNetAmountHUF", money(line.netAmount)),
        ]),
        element("data:lineVatRate", [vatRateContent(line)]),
        element("data:lineVatData", [
          element("data:lineVatAmount", money(line.vatAmount)),
          element("data:lineVatAmountHUF", money(line.vatAmount)),
        ]),
        element("data:lineGrossAmountData", [
          element("data:lineGrossAmountNormal", money(line.grossAmount)),
          element("data:lineGrossAmountNormalHUF", money(line.grossAmount)),
        ]),
      ]),
    ]),
  );
}

function summaryNode(invoice: NavInvoice): XmlNode {
  return element("data:invoiceSummary", [
    element("data:summaryNormal", [
      ...invoice.vatSummary.map((row) =>
        element("data:summaryByVatRate", [
          element("data:vatRate", [vatRateContent(row)]),
          element("data:vatRateNetData", [
            element("data:vatRateNetAmount", money(row.net)),
            element("data:vatRateNetAmountHUF", money(row.net)),
          ]),
          element("data:vatRateVatData", [
            element("data:vatRateVatAmount", money(row.vat)),
            element("data:vatRateVatAmountHUF", money(row.vat)),
          ]),
        ]),
      ),
      element("data:invoiceNetAmount", money(invoice.totalNet)),
      element("data:invoiceNetAmountHUF", money(invoice.totalNet)),
      element("data:invoiceVatAmount", money(invoice.totalVat)),
      element("data:invoiceVatAmountHUF", money(invoice.totalVat)),
    ]),
    element("data:summaryGrossData", [
      element("data:invoiceGrossAmount", money(invoice.totalGross)),
      element("data:invoiceGrossAmountHUF", money(invoice.totalGross)),
    ]),
  ]);
}

export function invoiceDataXml(invoice: NavInvoice): string {
  const root = element(
    "data:InvoiceData",
    [
      element("data:invoiceNumber", invoice.invoiceNumber),
      element("data:invoiceIssueDate", invoice.issueDate),
      // False: this is invoice data, not a whole invoice image in the report.
      element("data:completenessIndicator", "false"),
      element("data:invoiceMain", [
        element(
          "data:invoice",
          optional([
            invoice.reverses
              ? element("data:invoiceReference", [
                  element("data:originalInvoiceNumber", invoice.reverses),
                  // The original was reported by us, so NAV can find it.
                  element("data:modifyWithoutMaster", "false"),
                  // Which correction this is in the original's chain. NAV
                  // refuses the reference without it, and the numbers must be
                  // unique within one invoice's chain.
                  element("data:modificationIndex", String(invoice.modificationIndex ?? 1)),
                ])
              : undefined,
            element("data:invoiceHead", [
              supplierNode(invoice),
              customerNode(invoice),
              element("data:invoiceDetail", [
                element("data:invoiceCategory", "NORMAL"),
                element("data:invoiceDeliveryDate", invoice.deliveryDate),
                element("data:currencyCode", invoice.currency ?? "HUF"),
                element("data:exchangeRate", "1"),
                element("data:paymentMethod", invoice.paymentMethod),
                ...(invoice.paymentDate
                  ? [element("data:paymentDate", invoice.paymentDate)]
                  : []),
                element("data:invoiceAppearance", "ELECTRONIC"),
              ]),
            ]),
            element("data:invoiceLines", [
              element("data:mergedItemIndicator", "false"),
              ...invoice.lines.map(lineNode),
            ]),
            summaryNode(invoice),
          ]),
        ),
      ]),
    ],
    {
      "xmlns:data": DATA_NS,
      "xmlns:base": "http://schemas.nav.gov.hu/OSA/3.0/base",
      "xmlns:common": "http://schemas.nav.gov.hu/NTCA/1.0/common",
    },
  );
  return writeXml(root);
}

/** What manageInvoice sends: the XML, base64 encoded, as the schema requires. */
export function invoiceDataBase64(invoice: NavInvoice): string {
  return Buffer.from(invoiceDataXml(invoice), "utf8").toString("base64");
}
