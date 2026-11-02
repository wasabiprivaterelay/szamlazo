import { formatDateHu, formatMoney, paymentMethodLabel, type Party, type PaymentMethod } from "@szamlazo/invoicing";

/**
 * What the server writes to people. Buyers and the business owner get
 * Hungarian; alerts go to whoever runs the server, in English like the logs.
 * Plain text only: every mail program shows it, and a buyer's name cannot
 * smuggle markup into it.
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

export function invoiceEmail(invoice: InvoiceForEmail, isTest: boolean): { subject: string; text: string } {
  const { seller, buyer } = invoice;
  if (invoice.type === "storno") {
    return {
      subject: `${test(isTest)}Sztornó számla: ${invoice.invoiceNumber} – ${seller.name}`,
      text: [
        `Kedves ${buyer.name}!`,
        "",
        `A(z) ${invoice.reverses ?? "korábbi"} számú számlát érvénytelenítettük. Mellékelve küldjük a sztornó számlát (${invoice.invoiceNumber}).`,
        "",
        "Üdvözlettel:",
        signature(seller),
      ].join("\n"),
    };
  }

  const payment =
    invoice.paymentMethod === "transfer"
      ? [
          `Fizetési határidő: ${formatDateHu(new Date(`${invoice.dueDate}T00:00:00Z`))}`,
          seller.bankAccount ? `Bankszámlaszám: ${seller.bankAccount}` : undefined,
          `Közlemény: ${invoice.invoiceNumber}`,
        ]
      : [`Fizetési mód: ${paymentMethodLabel(invoice.paymentMethod).toLowerCase()}`];

  return {
    subject: `${test(isTest)}Számla: ${invoice.invoiceNumber} – ${seller.name}`,
    text: [
      `Kedves ${buyer.name}!`,
      "",
      `Mellékelve küldjük a(z) ${invoice.invoiceNumber} számú számlát.`,
      "",
      `Összeg: ${formatMoney(invoice.totalGross, invoice.currency)}`,
      ...payment.filter((line): line is string => Boolean(line)),
      "",
      "Üdvözlettel:",
      signature(seller),
    ].join("\n"),
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
