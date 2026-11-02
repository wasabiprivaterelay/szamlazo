import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  Alignment,
  Content,
  ContentTable,
  CustomTableLayout,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces.js";
import {
  formatDateHu,
  formatMoney,
  formatUnitAmount,
  formatTaxNumber,
  formatUnitMoney,
  paymentMethodLabel,
} from "./format.js";
import type { Invoice, Party, VatExemption } from "./types.js";

/**
 * The invoice as a PDF. pdfmake carries Roboto with it, which has the whole of
 * Latin Extended-A: a PDF built on one of the standard PostScript fonts would
 * print "Előre" as "Elre", because their encoding has no ő or ű.
 */

const require = createRequire(import.meta.url);

/**
 * pdfmake's own type declarations describe its older server API, so what is
 * used of the current one is declared here.
 */
type OutputDocument = { getBuffer(): Promise<Buffer> };

type PdfMake = {
  setFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
  createPdf(definition: TDocumentDefinitions): OutputDocument;
};

const pdfmake = require("pdfmake") as PdfMake;

/** Roboto ships inside pdfmake; resolving its package.json finds the folder. */
const ROBOTO = join(require.resolve("pdfmake/package.json"), "..", "build", "fonts", "Roboto");

const ROBOTO_FONTS = {
  Roboto: {
    normal: join(ROBOTO, "Roboto-Regular.ttf"),
    bold: join(ROBOTO, "Roboto-Medium.ttf"),
    italics: join(ROBOTO, "Roboto-Italic.ttf"),
    bolditalics: join(ROBOTO, "Roboto-MediumItalic.ttf"),
  },
};

export type PdfOptions = {
  /** A logo, as PNG or JPEG bytes. Printed top left at its natural ratio. */
  logo?: Uint8Array;
  logoWidth?: number;
  /** Headings and rules take this colour. */
  accentColour?: string;
  /**
   * What the document says it is. A storno keeps the same title with the type
   * beside it, because it is still an invoice in law.
   */
  title?: string;
  /** Printed at the very bottom, small: statutory notes, thanks, a website. */
  footer?: string;
  /** Fixed creation time, so that rendering the same invoice twice matches. */
  createdAt?: Date;
};

const RIGHT: Alignment = "right";
const LEFT: Alignment = "left";

const INK = "#1f1a17";
const MUTED = "#6b625c";
const RULE = "#d8d0c8";

/** A rule under the header and a hairline between lines; no vertical rules. */
const LINES_LAYOUT: CustomTableLayout = {
  hLineWidth: (index: number, node: ContentTable) =>
    index === 0 || index === 1 || index === node.table.body.length ? 0.8 : 0.4,
  vLineWidth: () => 0,
  hLineColor: (index: number) => (index <= 1 ? RULE : "#eae4dd"),
  paddingTop: () => 5,
  paddingBottom: () => 5,
  paddingLeft: (index: number) => (index === 0 ? 0 : 8),
  paddingRight: () => 0,
};

/** A rule above the amount due, nothing else. */
const TOTALS_LAYOUT: CustomTableLayout = {
  hLineWidth: (index: number, node: ContentTable) =>
    index === node.table.body.length - 1 ? 0.8 : 0,
  vLineWidth: () => 0,
  hLineColor: () => RULE,
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 0,
  paddingRight: () => 0,
};

/** The dates block: a plain list of label and value, no rules at all. */
const FACTS_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingTop: () => 1.5,
  paddingBottom: () => 1.5,
  paddingLeft: () => 0,
  paddingRight: () => 0,
};

function partyBlock(heading: string, party: Party, accent: string): Content {
  const lines: string[] = [party.name];
  if (party.lines) {
    lines.push(...party.lines.filter((line) => line.trim() !== ""));
  } else {
    lines.push(`${party.postcode} ${party.city}`, party.address);
    if (party.taxNumber) lines.push(`Adószám: ${formatTaxNumber(party.taxNumber)}`);
    if (party.registrationNumber) lines.push(`Nyilvántartási szám: ${party.registrationNumber}`);
    if (party.bankAccount) lines.push(`Bankszámlaszám: ${party.bankAccount}`);
    if (party.email) lines.push(party.email);
    if (party.phone) lines.push(party.phone);
  }

  return {
    stack: [
      { text: heading, color: accent, bold: true, fontSize: 8, characterSpacing: 0.6 },
      { text: lines[0]!, bold: true, margin: [0, 3, 0, 0] },
      ...lines.slice(1).map((line) => ({ text: line, color: MUTED })),
    ],
    fontSize: 9.5,
  };
}

function facts(invoice: Invoice): TableCell[][] {
  const rows: [string, string][] = [
    ["Számla kelte", formatDateHu(invoice.issueDate)],
    ["Teljesítés napja", formatDateHu(invoice.fulfilmentDate)],
    ["Fizetési határidő", formatDateHu(invoice.dueDate)],
    ["Fizetési mód", paymentMethodLabel(invoice.paymentMethod)],
  ];
  if (invoice.orderNumber) rows.push(["Hivatkozás", invoice.orderNumber]);
  if (invoice.originalInvoiceNumber) {
    rows.push(["Sztornózott számla", invoice.originalInvoiceNumber]);
  }
  return rows.map(([label, value]) => [
    { text: label, color: MUTED, fontSize: 9.5 },
    { text: value, alignment: RIGHT, fontSize: 9.5 },
  ]);
}

/** What stands in the rate column for a line without VAT. */
const EXEMPTION_LABEL: Record<VatExemption["case"], string> = {
  AAM: "AAM",
  TAM: "TAM",
  ATK: "ÁKK",
  REVERSE_CHARGE: "FAD",
};

function rateLabel(row: { vatRate: number; vatExemption?: VatExemption }): string {
  return row.vatExemption ? EXEMPTION_LABEL[row.vatExemption.case] : `${row.vatRate}%`;
}

/**
 * The legal reference for every line without VAT, once per reason, which the
 * law requires on the invoice (Áfa tv. 169. § m) and n)).
 */
function exemptionNotes(invoice: Invoice): Content[] {
  const seen = new Map<string, string>();
  for (const row of invoice.vatSummary) {
    if (!row.vatExemption) continue;
    seen.set(`${row.vatExemption.case}:${row.vatExemption.reason}`, `${rateLabel(row)}: ${row.vatExemption.reason}`);
  }
  if (seen.size === 0) return [];
  return [{ text: [...seen.values()].join("\n"), fontSize: 9, margin: [0, 16, 0, 0] }];
}

function lineTable(invoice: Invoice, accent: string): Content {
  const header = [
    "Tétel neve",
    "Mennyiség",
    "Egységár (nettó)",
    "Áfakulcs",
    "Nettó",
    "Áfa összege",
    "Bruttó",
  ].map<TableCell>((text, index) => ({
    text,
    bold: true,
    fontSize: 8.5,
    color: accent,
    alignment: index === 0 ? LEFT : RIGHT,
  }));

  const body = invoice.lines.map<TableCell[]>((line) => {
    // The unit price is stated net, as an invoice must, and taken from the
    // line's net so that quantity times unit price gives exactly the line.
    const unitNet = line.lineNet / line.quantity;
    return [
      { text: line.description, fontSize: 9.5 },
      {
        // Through formatting, so a reversed line reads −2 with the same minus
        // sign as the amounts beside it rather than a hyphen.
        text: `${formatUnitAmount(line.quantity)} ${line.unit}`,
        alignment: RIGHT,
        fontSize: 9.5,
      },
      { text: formatUnitMoney(unitNet, invoice.currency), alignment: RIGHT, fontSize: 9.5 },
      { text: rateLabel(line), alignment: RIGHT, fontSize: 9.5 },
      { text: formatMoney(line.lineNet, invoice.currency), alignment: RIGHT, fontSize: 9.5 },
      { text: formatMoney(line.lineVat, invoice.currency), alignment: RIGHT, fontSize: 9.5 },
      {
        text: formatMoney(line.lineGross, invoice.currency),
        alignment: RIGHT,
        bold: true,
        fontSize: 9.5,
      },
    ];
  });

  return {
    table: {
      headerRows: 1,
      widths: ["*", "auto", "auto", "auto", "auto", "auto", "auto"],
      body: [header, ...body],
    },
    layout: LINES_LAYOUT,
    margin: [0, 18, 0, 0],
  };
}

const baseLabel = (row: { vatRate: number; vatExemption?: VatExemption }) =>
  row.vatExemption ? `${rateLabel(row)} alapja` : `${row.vatRate}% áfa alapja`;
const vatLabel = (row: { vatRate: number; vatExemption?: VatExemption }) =>
  row.vatExemption ? `Áfa (${rateLabel(row)})` : `Áfa ${row.vatRate}%`;

function summary(invoice: Invoice, accent: string): Content {
  const money = (amount: number) => formatMoney(amount, invoice.currency);
  const line = (label: string, amount: number): TableCell[] => [
    { text: label, color: MUTED, fontSize: 9.5 },
    { text: money(amount), alignment: RIGHT, fontSize: 9.5 },
  ];

  /**
   * With one VAT rate, which is most invoices, the net of
   * the invoice is the base of that rate, so it is named plainly. With
   * several, the law wants the base stated per rate, so those come first and
   * the net of the whole invoice follows them.
   */
  const rows: TableCell[][] =
    invoice.vatSummary.length === 1
      ? [
          line("Számla nettó értéke", invoice.totalNet),
          line(vatLabel(invoice.vatSummary[0]!), invoice.vatSummary[0]!.vat),
        ]
      : [
          ...invoice.vatSummary.map((row) => line(baseLabel(row), row.net)),
          // A row without VAT has its base above and its reason below; a 0 Ft
          // VAT line for it would only be noise.
          ...invoice.vatSummary.filter((row) => !row.vatExemption).map((row) => line(vatLabel(row), row.vat)),
          line("Számla nettó értéke", invoice.totalNet),
        ];

  return {
    columns: [
      { text: "", width: "*" },
      {
        width: 260,
        table: {
          widths: ["*", "auto"],
          body: [
            ...rows,
            [
              { text: "Fizetendő", bold: true, fontSize: 12, color: accent, margin: [0, 4, 0, 0] },
              {
                text: money(invoice.totalGross),
                alignment: RIGHT,
                bold: true,
                fontSize: 12,
                color: accent,
                margin: [0, 4, 0, 0],
              },
            ],
          ],
        },
        layout: TOTALS_LAYOUT,
      },
    ],
    margin: [0, 16, 0, 0],
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/**
 * A logo that is not a PNG or a JPEG hangs the renderer rather than failing,
 * so it is turned away here with something a caller can read.
 */
function checkImage(bytes: Uint8Array): void {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (!starts(PNG_SIGNATURE) && !starts(JPEG_SIGNATURE)) {
    throw new Error("the logo must be PNG or JPEG bytes");
  }
}

function documentOf(invoice: Invoice, options: PdfOptions): TDocumentDefinitions {
  const accent = options.accentColour ?? "#8c2f2c";
  const title = options.title ?? "Számla";
  const heading = invoice.type === "storno" ? `${title} (sztornó)` : title;

  const head: Content = {
    columns: [
      options.logo
        ? {
            width: (options.logoWidth ?? 96) + 16,
            image: `data:image/png;base64,${Buffer.from(options.logo).toString("base64")}`,
            fit: [options.logoWidth ?? 96, options.logoWidth ?? 96],
          }
        : { width: "*", text: invoice.seller.name, bold: true, fontSize: 14 },
      {
        width: "*",
        stack: [
          { text: heading, bold: true, fontSize: 20, color: accent, alignment: RIGHT },
          {
            text: invoice.invoiceNumber,
            fontSize: 12,
            alignment: RIGHT,
            margin: [0, 2, 0, 0],
          },
        ],
      },
    ],
  };

  return {
    info: {
      title: `${heading} ${invoice.invoiceNumber}`,
      author: invoice.seller.name,
      creationDate: options.createdAt,
    },
    pageSize: "A4",
    pageMargins: [48, 48, 48, 64],
    defaultStyle: { font: "Roboto", fontSize: 10, color: INK, lineHeight: 1.25 },
    content: [
      head,
      {
        columns: [
          partyBlock("SZÁLLÍTÓ", invoice.seller, accent),
          partyBlock("VEVŐ", invoice.buyer, accent),
        ],
        columnGap: 24,
        margin: [0, 22, 0, 0],
      },
      {
        columns: [
          { text: "", width: "*" },
          {
            width: 260,
            table: { widths: ["*", "auto"], body: facts(invoice) },
            layout: FACTS_LAYOUT,
          },
        ],
        margin: [0, 18, 0, 0],
      },
      lineTable(invoice, accent),
      summary(invoice, accent),
      ...exemptionNotes(invoice),
      ...(invoice.note ? [{ text: invoice.note, fontSize: 9, color: MUTED, margin: [0, 20, 0, 0] } as Content] : []),
      {
        text: `A számla ${invoice.currency} pénznemben értendő. Az összegek forintra kerekítettek.`,
        fontSize: 8,
        color: MUTED,
        margin: [0, 14, 0, 0],
      },
    ],
    footer: options.footer
      ? () => ({
          text: options.footer!,
          fontSize: 7.5,
          color: MUTED,
          alignment: "center" as Alignment,
          margin: [48, 16, 48, 0],
        })
      : undefined,
  };
}

/**
 * Renders the invoice and resolves with the PDF bytes. The same invoice and
 * the same createdAt give the same bytes, which is what lets the stored
 * SHA-256 hash mean something.
 */
export async function renderInvoicePdf(
  invoice: Invoice,
  options: PdfOptions = {},
): Promise<Uint8Array> {
  if (options.logo) checkImage(options.logo);
  pdfmake.setFonts(ROBOTO_FONTS);
  // Rendering an invoice reads the bundled fonts and nothing else: no request
  // leaves the machine, and no other file on it is opened.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path) => path.startsWith(ROBOTO));

  const document = pdfmake.createPdf(documentOf(invoice, options));
  return new Uint8Array(await document.getBuffer());
}
