#!/usr/bin/env node
/**
 * The NAV client from the command line: check that a technical user works,
 * look up tax numbers, read NAV's records, and send a made-up invoice to the
 * test system to see the whole round trip. Reads its settings from the
 * environment (see .env.example); nothing it prints is secret.
 *
 *   nav-online-szamla check
 *   nav-online-szamla taxpayer 12345678 [more…]
 *   nav-online-szamla digest 2026-09-01 2026-09-30 [--inbound]
 *   nav-online-szamla invoice SZ2026/00001 [--inbound]
 *   nav-online-szamla status <transaction id>
 *   nav-online-szamla test-invoice [--storno]
 */
import { NavError } from "./client.js";
import type { NavInvoice, NavParty } from "./invoice-xml.js";
import { NavConfigError, navClientFromEnv, navEnvironmentOf, taxpayerIdOf } from "./env.js";
import { InvalidXmlText } from "./xml.js";

const USAGE = `usage: nav-online-szamla <command>

  check                         prove the technical user works: token exchange and
                                a lookup of your own tax number
  taxpayer <tax number> [...]   what NAV knows about a tax number
  digest <from> <to> [--inbound]
                                invoices NAV holds for a period (yyyy-mm-dd, at most 35 days)
  invoice <number> [--inbound]  one invoice as NAV stored it
  status <transaction id>       the verdict on a submission
  test-invoice [--storno]       send a made-up invoice to NAV's TEST system and wait
                                for the verdict; with --storno, reverse it as well

Settings come from the environment: NAV_ENVIRONMENT, NAV_LOGIN, NAV_PASSWORD,
NAV_SIGNING_KEY, NAV_EXCHANGE_KEY, NAV_TAX_NUMBER, NAV_SOFTWARE_DEV_NAME,
NAV_SOFTWARE_DEV_CONTACT. See .env.example.`;

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const params = args.slice(1).filter((arg) => !arg.startsWith("--"));
const direction = flags.has("--inbound") ? "INBOUND" : "OUTBOUND";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isDate = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  if (!command || command === "help" || flags.has("--help")) {
    console.log(USAGE);
    return;
  }

  const env = process.env;
  const client = navClientFromEnv(env);
  const environment = navEnvironmentOf(env);
  console.error(`NAV ${environment} system\n`);

  switch (command) {
    case "check": {
      const token = await client.tokenExchange();
      console.log(`token exchange   ok (token valid until ${token.validTo || "unknown"})`);
      const own = await client.queryTaxpayer(env.NAV_TAX_NUMBER!);
      if (!own.valid) fail(`taxpayer lookup  NAV does not know ${own.taxpayerId} as a valid taxpayer`);
      console.log(`taxpayer lookup  ok: ${own.name} (${own.taxpayerId}-${own.vatCode ?? "?"}-${own.countyCode ?? "??"})`);
      console.log("\nThe technical user, the signing key and the exchange key all work.");
      return;
    }

    case "taxpayer": {
      if (params.length === 0) fail("give at least one tax number", 64);
      for (const number of params) {
        const found = await client.queryTaxpayer(number);
        if (!found.valid) {
          console.log(`${number}: not a valid taxpayer`);
          continue;
        }
        const hq = found.addresses.find((address) => address.type === "HQ") ?? found.addresses[0];
        console.log(
          `${found.taxpayerId}-${found.vatCode ?? "?"}-${found.countyCode ?? "??"}  ${found.name}` +
            (hq ? `\n  ${hq.postalCode} ${hq.city}, ${hq.address}` : ""),
        );
      }
      return;
    }

    case "digest": {
      const [from, to] = params;
      if (!isDate(from) || !isDate(to)) fail("give two dates: digest 2026-09-01 2026-09-30", 64);
      const list = await client.queryInvoiceDigest(from!, to!, direction);
      for (const one of list) {
        console.log(`${one.issueDate}  ${one.invoiceNumber.padEnd(20)} ${one.operation.padEnd(7)} net ${one.netAmount}  vat ${one.vatAmount}`);
      }
      console.log(`\n${list.length} invoice(s)`);
      return;
    }

    case "invoice": {
      const [number] = params;
      if (!number) fail("give an invoice number", 64);
      const stored = await client.queryInvoiceData(number, direction);
      if (!stored) fail(`NAV has no ${direction.toLowerCase()} invoice numbered ${number}`);
      console.log(`received ${stored.receivedAt} via ${stored.source}, transaction ${stored.transactionId ?? "-"}\n`);
      console.log(stored.xml);
      return;
    }

    case "status": {
      const [transactionId] = params;
      if (!transactionId) fail("give a transaction id", 64);
      printStatus(await client.queryTransactionStatus(transactionId));
      return;
    }

    case "test-invoice": {
      if (environment !== "test") {
        fail("test-invoice only talks to NAV's test system: set NAV_ENVIRONMENT=test", 64);
      }
      const own = await client.queryTaxpayer(env.NAV_TAX_NUMBER!);
      if (!own.valid) fail(`NAV does not know ${taxpayerIdOf(env.NAV_TAX_NUMBER!)} as a valid taxpayer`);
      const hq = own.addresses.find((address) => address.type === "HQ") ?? own.addresses[0];
      const supplier: NavParty = {
        name: own.name,
        taxpayerId: own.taxpayerId,
        vatCode: own.vatCode,
        countyCode: own.countyCode,
        postalCode: hq?.postalCode ?? "1011",
        city: hq?.city ?? "Budapest",
        address: hq?.address ?? "Fő utca 1.",
      };
      const today = new Date().toISOString().slice(0, 10);
      const number = `TESZT${Date.now()}`;
      const invoice: NavInvoice = {
        invoiceNumber: number,
        issueDate: today,
        deliveryDate: today,
        paymentDate: today,
        paymentMethod: "TRANSFER",
        currency: "HUF",
        supplier,
        customer: { name: "Teszt Vevő", postalCode: "1011", city: "Budapest", address: "Teszt utca 1." },
        customerVatStatus: "PRIVATE_PERSON",
        lines: [
          {
            description: "Teszt tétel",
            quantity: 1,
            unitOfMeasure: "PIECE",
            unitPriceNet: 10000,
            netAmount: 10000,
            vatAmount: 2700,
            grossAmount: 12700,
            vatRate: 27,
          },
        ],
        vatSummary: [{ vatRate: 27, net: 10000, vat: 2700 }],
        totalNet: 10000,
        totalVat: 2700,
        totalGross: 12700,
      };

      const accepted = await submitAndWait(number, () =>
        client.manageInvoice([{ operation: "CREATE", invoice }]),
      );
      if (!accepted || !flags.has("--storno")) return;

      const stornoNumber = `TESZT${Date.now()}S`;
      const storno: NavInvoice = {
        ...invoice,
        invoiceNumber: stornoNumber,
        lines: invoice.lines.map((line, index) => ({
          ...line,
          lineNumber: index + 1,
          modifies: { lineNumberReference: invoice.lines.length + index + 1, operation: "CREATE" as const },
          quantity: -line.quantity,
          netAmount: -line.netAmount,
          vatAmount: -line.vatAmount,
          grossAmount: -line.grossAmount,
        })),
        vatSummary: invoice.vatSummary.map((row) => ({ ...row, net: -row.net, vat: -row.vat })),
        totalNet: -invoice.totalNet,
        totalVat: -invoice.totalVat,
        totalGross: -invoice.totalGross,
        reverses: number,
        modificationIndex: 1,
      };
      console.log("");
      await submitAndWait(stornoNumber, () => client.manageInvoice([{ operation: "STORNO", invoice: storno }]));
      return;
    }

    default:
      fail(`unknown command: ${command}\n\n${USAGE}`, 64);
  }

  async function submitAndWait(number: string, send: () => Promise<{ transactionId: string }>): Promise<boolean> {
    console.log(`sending ${number} …`);
    const { transactionId } = await send();
    console.log(`transaction ${transactionId}`);
    for (let attempt = 1; attempt <= 24; attempt++) {
      await sleep(2500);
      const status = await client.queryTransactionStatus(transactionId);
      if (!status.finished) {
        console.log(`  waiting for NAV (${status.invoices.map((one) => one.status).join(", ") || "RECEIVED"})`);
        continue;
      }
      printStatus(status);
      const done = status.invoices.every((one) => one.status === "DONE");
      console.log(done ? `\nNAV accepted ${number}.` : `\nNAV did not accept ${number}.`);
      return done;
    }
    console.log(`\nNAV has not decided after a minute; ask later with: status ${transactionId}`);
    return false;
  }
}

function printStatus(status: { finished: boolean; invoices: { index: number; status: string; messages: string[] }[] }) {
  for (const one of status.invoices) {
    console.log(`invoice ${one.index}: ${one.status}`);
    for (const message of one.messages) console.log(`  - ${message}`);
  }
  if (!status.finished) console.log("(NAV is still processing)");
}

main().catch((error: unknown) => {
  if (error instanceof NavConfigError) fail(`configuration: ${error.message}`, 78);
  if (error instanceof InvalidXmlText) fail(error.message, 65);
  if (error instanceof NavError) {
    console.error(`NAV refused ${error.operation}: ${error.errorCode ?? "(no code)"} - ${error.message}`);
    for (const line of error.validations) console.error(`  - ${line}`);
    if (error.errorCode === "INVALID_SECURITY_USER" || error.errorCode === "NOT_REGISTERED_CUSTOMER") {
      console.error("\nCheck NAV_LOGIN, NAV_PASSWORD and NAV_TAX_NUMBER, and that they belong to this NAV_ENVIRONMENT.");
    }
    if (error.errorCode === "INVALID_REQUEST_SIGNATURE") {
      console.error("\nCheck NAV_SIGNING_KEY: it is the 'XML aláírókulcs' shown when the technical user was created.");
    }
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
