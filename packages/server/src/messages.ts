import { formatDateHu, formatMoney, paymentMethodLabel, type Party, type PaymentMethod } from "@szamlazo/invoicing";

/**
 * What the server writes to people. Buyers and the business owner get
 * Hungarian; alerts go to whoever runs the server, in English like the logs.
 * Invoice emails carry HTML beside the plain text; every value in the HTML
 * is escaped, so a buyer's name cannot smuggle markup into it. The rest is
 * plain text.
 */

type InvoiceForEmail = {
  invoiceNumber: string;
  type: "normal" | "storno";
  totalGross: number;
  currency: string;
  paymentMethod: PaymentMethod;
  dueDate: string;
  buyer: Party;
  seller: Party;
  /** For a storno: the invoice it reverses. */
  reverses?: string;
};

const test = (isTest: boolean) => (isTest ? "[TESZT] " : "");

function signature(seller: Party): string {
  return [seller.name, seller.email, seller.phone].filter(Boolean).join("\n");
}

/** How the invoice email looks: the colour of the PDF's accent. */
export type EmailBrand = { accent: string };

const DEFAULT_BRAND: EmailBrand = { accent: "#1d4f86" };

/** Everything a buyer, a seller or an invoice puts into the HTML goes through here. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One label and value row of the details table; the value is escaped here. */
function row(label: string, value: string, strong = false): string {
  return (
    `<tr><td style="padding:10px 0;border-top:1px solid #e6e9ee;color:#5b6573;font-size:14px;">${escapeHtml(label)}</td>` +
    `<td align="right" style="padding:10px 0;border-top:1px solid #e6e9ee;color:#18202b;font-size:14px;${strong ? "font-weight:600;" : ""}` +
    `font-variant-numeric:tabular-nums;">${escapeHtml(value)}</td></tr>`
  );
}

/**
 * The HTML beside the plain text: tables and inline styles only, which is
 * what mail programs reliably draw, and no images to fetch, so nothing is
 * blocked and nothing reports that the mail was opened.
 */
function invoiceHtml(parts: {
  isTest: boolean;
  brand: EmailBrand;
  preheader: string;
  heading: string;
  greeting: string;
  intro: string;
  amountLabel?: string;
  amount?: string;
  rows: string[];
  note?: string;
  seller: Party;
}): string {
  const { seller, brand } = parts;
  const accent = /^#[0-9a-fA-F]{6}$/.test(brand.accent) ? brand.accent : DEFAULT_BRAND.accent;
  const sellerLine = [
    `${seller.postcode} ${seller.city}, ${seller.address}`,
    seller.taxNumber ? `Adószám: ${seller.taxNumber}` : undefined,
  ]
    .filter(Boolean)
    .map((line) => escapeHtml(line!))
    .join("<br>");
  const contact = [seller.email, seller.phone].filter(Boolean).map((line) => escapeHtml(line!)).join(" &nbsp;·&nbsp; ");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(parts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${font};">
${
  parts.isTest
    ? `<tr><td style="padding:10px 16px;margin-bottom:12px;background:#fff4d6;color:#7a5400;font-size:13px;border-radius:8px;">Ez a levél tesztrendszerből érkezett. A csatolt számla nem valódi.</td></tr><tr><td style="height:12px;"></td></tr>`
    : ""
}
<tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${accent};padding:32px 32px 28px;">
<div style="font-size:14px;font-weight:600;color:${accent};letter-spacing:0.2px;">${escapeHtml(seller.name)}</div>
<h1 style="margin:20px 0 0;font-size:24px;line-height:1.25;font-weight:600;color:#18202b;">${escapeHtml(parts.heading)}</h1>
<p style="margin:20px 0 0;font-size:15px;line-height:1.6;color:#18202b;">${escapeHtml(parts.greeting)}</p>
<p style="margin:8px 0 0;font-size:15px;line-height:1.6;color:#18202b;">${escapeHtml(parts.intro)}</p>
${
  parts.amount
    ? `<div style="margin:28px 0 4px;font-size:13px;color:#5b6573;">${escapeHtml(parts.amountLabel ?? "Fizetendő")}</div>
<div style="font-size:34px;line-height:1.1;font-weight:700;color:#18202b;font-variant-numeric:tabular-nums;">${escapeHtml(parts.amount)}</div>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-bottom:1px solid #e6e9ee;">
${parts.rows.join("\n")}
</table>
${parts.note ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#5b6573;">${escapeHtml(parts.note)}</p>` : ""}
<p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#5b6573;">A számlát PDF formátumban csatoltuk ehhez a levélhez.</p>
<p style="margin:24px 0 0;font-size:15px;line-height:1.6;color:#18202b;">Üdvözlettel:<br><strong style="font-weight:600;">${escapeHtml(seller.name)}</strong></p>
</td></tr>
<tr><td style="padding:20px 32px 0;font-size:12px;line-height:1.6;color:#8a93a0;">
${escapeHtml(seller.name)}<br>${sellerLine}${contact ? `<br>${contact}` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function invoiceEmail(
  invoice: InvoiceForEmail,
  isTest: boolean,
  brand: EmailBrand = DEFAULT_BRAND,
): { subject: string; text: string; html: string } {
  const { seller, buyer } = invoice;
  const greeting = `Kedves ${buyer.name}!`;
  const amount = formatMoney(invoice.totalGross, invoice.currency);

  if (invoice.type === "storno") {
    const intro = `A(z) ${invoice.reverses ?? "korábbi"} számú számlát érvénytelenítettük. Mellékelve küldjük a sztornó számlát (${invoice.invoiceNumber}).`;
    return {
      subject: `${test(isTest)}Sztornó számla: ${invoice.invoiceNumber} – ${seller.name}`,
      text: [greeting, "", intro, "", "Üdvözlettel:", signature(seller)].join("\n"),
      html: invoiceHtml({
        isTest,
        brand,
        preheader: `A(z) ${invoice.reverses ?? "korábbi"} számú számla érvénytelenítése.`,
        heading: "Sztornó számla",
        greeting,
        intro,
        rows: [
          row("Sztornó számla száma", invoice.invoiceNumber, true),
          ...(invoice.reverses ? [row("Érvénytelenített számla", invoice.reverses)] : []),
        ],
        note: "Ezzel a számlával kapcsolatban nincs teendője. Ha az eredeti számlát már kifizette, a visszatérítés ügyében keressen minket.",
        seller,
      }),
    };
  }

  const due = formatDateHu(new Date(`${invoice.dueDate}T00:00:00Z`));
  const transfer = invoice.paymentMethod === "transfer";
  const payment = transfer
    ? [
        `Fizetési határidő: ${due}`,
        seller.bankAccount ? `Bankszámlaszám: ${seller.bankAccount}` : undefined,
        `Közlemény: ${invoice.invoiceNumber}`,
      ]
    : [`Fizetés módja: ${paymentMethodLabel(invoice.paymentMethod).toLowerCase()}`];
  const intro = `Mellékelve küldjük a(z) ${invoice.invoiceNumber} számú számlát.`;

  return {
    subject: `${test(isTest)}Számla: ${invoice.invoiceNumber} – ${seller.name}`,
    text: [
      greeting,
      "",
      intro,
      "",
      `Összeg: ${amount}`,
      ...payment.filter((line): line is string => Boolean(line)),
      "",
      "Üdvözlettel:",
      signature(seller),
    ].join("\n"),
    html: invoiceHtml({
      isTest,
      brand,
      preheader: transfer ? `${amount}, fizetési határidő: ${due}` : `${amount}`,
      heading: `Számla ${invoice.invoiceNumber}`,
      greeting,
      intro,
      amountLabel: transfer ? "Fizetendő" : "Végösszeg",
      amount,
      rows: transfer
        ? [
            row("Fizetési határidő", due, true),
            ...(seller.bankAccount ? [row("Bankszámlaszám", seller.bankAccount)] : []),
            ...(seller.bankName ? [row("Bank", seller.bankName)] : []),
            row("Közlemény", invoice.invoiceNumber),
          ]
        : [row("Számla sorszáma", invoice.invoiceNumber), row("Fizetés módja", paymentMethodLabel(invoice.paymentMethod))],
      note: transfer ? "Kérjük, az átutalás közleményében tüntesse fel a számla számát." : undefined,
      seller,
    }),
  };
}

export function archiveEmail(month: string, count: number, part: string, isTest: boolean) {
  return {
    subject: `${test(isTest)}Számlák, ${month}${part}`,
    text:
      `A ${month} hónapban kiállított ${count} számla másolata${part}: a PDF-ek, ahogy a vevők megkapták, ` +
      "és ugyanezek a számlák a NAV Online Számla XML-formátumában.\n\n" +
      "Töltsd le és őrizd meg: ez a számlák második példánya, a szerveren kívül.",
  };
}

export function alertEmail(subject: string, body: string, isTest: boolean) {
  return {
    subject: `${test(isTest)}[szamlazo] ${subject}`,
    text: `${body}\n\nThe checker will email again when this is resolved.`,
  };
}

export function alertResolvedEmail(subject: string, isTest: boolean) {
  return {
    subject: `${test(isTest)}[szamlazo] resolved: ${subject}`,
    text: "This problem is no longer present.",
  };
}
