import { test } from "vitest";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { buildRequest } from "../src/request.js";
import { NavClient, NavError } from "../src/client.js";
import type { NavCredentials, SoftwareDescription } from "../src/config.js";

const credentials: NavCredentials = {
  login: "abcdef123456789",
  password: "Titkos123",
  signingKey: "ab12cd34ef56",
  exchangeKey: "0123456789abcdef",
  taxNumber: "12345678",
};

const software: SoftwareDescription = {
  softwareId: "12345678SAMPLE-001",
  softwareName: "Minta webshop",
  softwareOperation: "ONLINE_SERVICE",
  softwareMainVersion: "1.0",
  softwareDevName: "Minta Bt.",
  softwareDevContact: "info@example.com",
  softwareDevCountryCode: "HU",
  softwareDevTaxNumber: "12345678",
};

const timestamp = new Date("2026-09-22T12:00:00Z");

test("a request carries the header, the user and the software, in that order", () => {
  const { xml } = buildRequest("TokenExchangeRequest", {
    credentials,
    software,
    timestamp,
    requestId: "TESZT1",
  });

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><TokenExchangeRequest /);
  assert.match(xml, /xmlns="http:\/\/schemas\.nav\.gov\.hu\/OSA\/3\.0\/api"/);
  assert.match(xml, /xmlns:common="http:\/\/schemas\.nav\.gov\.hu\/NTCA\/1\.0\/common"/);
  assert.ok(
    xml.indexOf("<common:header>") < xml.indexOf("<common:user>") &&
      xml.indexOf("<common:user>") < xml.indexOf("<software>"),
    "the schema fixes this order",
  );
  assert.match(xml, /<common:requestVersion>3\.0<\/common:requestVersion>/);
  assert.match(xml, /<common:headerVersion>1\.0<\/common:headerVersion>/);
  assert.match(xml, /<common:timestamp>2026-09-22T12:00:00Z<\/common:timestamp>/);
});

test("the password and the signature name their algorithms", () => {
  const { xml } = buildRequest("TokenExchangeRequest", {
    credentials,
    software,
    timestamp,
    requestId: "TESZT1",
  });
  assert.match(xml, /<common:passwordHash cryptoType="SHA-512">B632488E/);
  assert.match(xml, /<common:requestSignature cryptoType="SHA3-512">77AE20A9/);
  // The literal password never appears anywhere in the request.
  assert.doesNotMatch(xml, /Titkos123/);
  assert.doesNotMatch(xml, /ab12cd34ef56/);
});

test("the optional software fields are left out when absent, not sent empty", () => {
  const { xml } = buildRequest("TokenExchangeRequest", {
    credentials,
    software: { ...software, softwareDevCountryCode: undefined, softwareDevTaxNumber: undefined },
    timestamp,
    requestId: "TESZT1",
  });
  assert.doesNotMatch(xml, /softwareDevCountryCode/);
  assert.doesNotMatch(xml, /softwareDevTaxNumber/);
});

test("credentials and software are checked before anything is sent", () => {
  const build = (over: Partial<NavCredentials>) =>
    buildRequest("TokenExchangeRequest", { credentials: { ...credentials, ...over }, software });
  assert.throws(() => build({ login: "short" }), /login/);
  assert.throws(() => build({ exchangeKey: "not sixteen bytes" }), /16 bytes/);
  assert.throws(() => build({ taxNumber: "12345678-2-41" }), /eight digits/);
  assert.throws(
    () =>
      buildRequest("TokenExchangeRequest", {
        credentials,
        software: { ...software, softwareId: "TOO-SHORT" },
      }),
    /18 characters/,
  );
});

test("special characters in what we send are escaped", () => {
  const { xml } = buildRequest("TokenExchangeRequest", {
    credentials,
    software: { ...software, softwareDevName: 'Alma & Társa "Kft"' },
    timestamp,
    requestId: "TESZT1",
  });
  assert.match(xml, /Alma &amp; Társa &quot;Kft&quot;/);
});

/** What NAV's test system actually answered on 2026-09-22, trimmed. */
const TOKEN_RESPONSE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:TokenExchangeResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"><header><requestId>SZ20260922200136OPGD9JM5</requestId><timestamp>2026-09-22T20:01:36Z</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><result><funcCode>OK</funcCode></result><ns2:encodedExchangeToken>gPosf78y3mFr/biK1lCLEw==</ns2:encodedExchangeToken><ns2:tokenValidityFrom>2026-09-22T20:01:36.855Z</ns2:tokenValidityFrom><ns2:tokenValidityTo>2026-09-22T20:06:36.857Z</ns2:tokenValidityTo></ns2:TokenExchangeResponse>`;

const ERROR_RESPONSE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><GeneralExceptionResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common"><funcCode>ERROR</funcCode><errorCode>INVALID_REQUEST</errorCode><message>Érvénytelen kérés!</message><notifications><notification><notificationCode>SCHEMA_VIOLATION</notificationCode><notificationText>Cannot find the declaration of element 'tokenExchangeRequest'.</notificationText></notification></notifications></GeneralExceptionResponse>`;

function clientAnswering(body: string, status = 200) {
  const seen: { url: string; xml: string }[] = [];
  const client = new NavClient({
    environment: "test",
    credentials,
    software,
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), xml: String(init?.body ?? "") });
      return new Response(body, { status });
    },
  });
  return { client, seen };
}

test("an operation posts to its own endpoint, with the root element capitalised", async () => {
  const { client, seen } = clientAnswering(TOKEN_RESPONSE);
  await client.tokenExchange();
  assert.equal(
    seen[0]!.url,
    "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/tokenExchange",
  );
  // NAV answers SCHEMA_VIOLATION to a lowercase root: the endpoint is
  // camelCase, the element is not.
  assert.match(seen[0]!.xml, /<TokenExchangeRequest /);
});

test("the token comes back decrypted", async () => {
  const { client } = clientAnswering(TOKEN_RESPONSE);
  const token = await client.tokenExchange();
  assert.equal(token.token, "token-abc123");
  assert.equal(token.validTo, "2026-09-22T20:06:36.857Z");
});

test("a refusal is an error carrying NAV's own code and message", async () => {
  const { client } = clientAnswering(ERROR_RESPONSE, 400);
  await assert.rejects(
    () => client.tokenExchange(),
    (error: unknown) => {
      assert.ok(error instanceof NavError);
      assert.equal(error.errorCode, "INVALID_REQUEST");
      assert.match(error.message, /Érvénytelen kérés/);
      assert.equal(error.operation, "tokenExchange");
      return true;
    },
  );
});

/**
 * NAV's answer to queryInvoiceData, in the shape the test system gave on
 * 2026-09-23: the invoice XML base64 encoded — re-serialised by NAV, not the
 * bytes we sent — and its own audit record beside it.
 */
function storedResponse(invoiceXml: string, compressed = false) {
  const payload = compressed
    ? gzipSync(Buffer.from(invoiceXml, "utf8")).toString("base64")
    : Buffer.from(invoiceXml, "utf8").toString("base64");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:QueryInvoiceDataResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"><header><requestId>R1</requestId><timestamp>2026-09-23T10:00:00Z</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><result><funcCode>OK</funcCode></result><ns2:invoiceDataResult><ns2:invoiceData>${payload}</ns2:invoiceData><ns2:auditData><ns2:insdate>2026-09-23T09:57:45Z</ns2:insdate><ns2:insCusUser>jbh6anaziqk69xf</ns2:insCusUser><ns2:source>MGM</ns2:source><ns2:transactionId>5IZNQ1KZB3XVGZ16</ns2:transactionId><ns2:index>1</ns2:index><ns2:originalRequestVersion>3.0</ns2:originalRequestVersion></ns2:auditData><ns2:compressedContentIndicator>${compressed}</ns2:compressedContentIndicator></ns2:invoiceDataResult></ns2:QueryInvoiceDataResponse>`;
}

const STORED_XML = `<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data"><invoiceNumber>SZ2026/00004</invoiceNumber></InvoiceData>`;

test("an invoice NAV holds comes back decoded, with NAV's record of it", async () => {
  const { client, seen } = clientAnswering(storedResponse(STORED_XML));
  const stored = await client.queryInvoiceData("SZ2026/00004");
  assert.equal(stored?.xml, STORED_XML);
  assert.equal(stored?.transactionId, "5IZNQ1KZB3XVGZ16");
  assert.equal(stored?.receivedAt, "2026-09-23T09:57:45Z");
  assert.equal(stored?.source, "MGM");
  assert.match(seen[0]!.url, /\/queryInvoiceData$/);
  assert.match(seen[0]!.xml, /<invoiceNumber>SZ2026\/00004<\/invoiceNumber><invoiceDirection>OUTBOUND</);
});

test("a compressed invoice is unzipped before it is handed back", async () => {
  const { client } = clientAnswering(storedResponse(STORED_XML, true));
  assert.equal((await client.queryInvoiceData("SZ2026/00004"))?.xml, STORED_XML);
});

test("an invoice NAV does not hold is null, not an error", async () => {
  const empty = `<?xml version="1.0" encoding="UTF-8"?><ns2:QueryInvoiceDataResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"><result><funcCode>OK</funcCode></result></ns2:QueryInvoiceDataResponse>`;
  const { client } = clientAnswering(empty);
  assert.equal(await client.queryInvoiceData("SZ2026/99999"), null);
});

/** A page of NAV's invoice list, in the shape the test system answers. */
function digestPage(page: number, pages: number, numbers: string[]) {
  const lines = numbers
    .map(
      (number) =>
        `<ns2:invoiceDigest><ns2:invoiceNumber>${number}</ns2:invoiceNumber><ns2:invoiceOperation>CREATE</ns2:invoiceOperation><ns2:invoiceCategory>NORMAL</ns2:invoiceCategory><ns2:invoiceIssueDate>2026-09-23</ns2:invoiceIssueDate><ns2:supplierTaxNumber>12345678</ns2:supplierTaxNumber><ns2:supplierName>NÉMETH ANDRÁS TIBOR</ns2:supplierName><ns2:currency>HUF</ns2:currency><ns2:invoiceNetAmount>4999</ns2:invoiceNetAmount><ns2:invoiceNetAmountHUF>4999</ns2:invoiceNetAmountHUF><ns2:invoiceVatAmount>1350</ns2:invoiceVatAmount><ns2:invoiceVatAmountHUF>1350</ns2:invoiceVatAmountHUF><ns2:transactionId>T${number.slice(-1)}</ns2:transactionId><ns2:index>1</ns2:index><ns2:insDate>2026-09-23T09:57:45Z</ns2:insDate></ns2:invoiceDigest>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ns2:QueryInvoiceDigestResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"><result><funcCode>OK</funcCode></result><ns2:invoiceDigestResult><ns2:currentPage>${page}</ns2:currentPage><ns2:availablePage>${pages}</ns2:availablePage>${lines}</ns2:invoiceDigestResult></ns2:QueryInvoiceDigestResponse>`;
}

test("NAV's invoice list is read page by page, until the last", async () => {
  const pages = [digestPage(1, 2, ["SZ2026/00004", "SZ2026/00005"]), digestPage(2, 2, ["SZ2026/00006"])];
  const seen: string[] = [];
  const client = new NavClient({
    environment: "test",
    credentials,
    software,
    fetchImpl: async (_input, init) => {
      seen.push(String(init?.body ?? ""));
      return new Response(pages[seen.length - 1]!, { status: 200 });
    },
  });

  const digest = await client.queryInvoiceDigest("2026-09-01", "2026-09-30");
  assert.deepEqual(
    digest.map((one) => one.invoiceNumber),
    ["SZ2026/00004", "SZ2026/00005", "SZ2026/00006"],
  );
  assert.equal(digest[0]!.netAmount, 4999);
  assert.equal(digest[0]!.vatAmount, 1350);
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /<page>1<\/page><invoiceDirection>OUTBOUND<\/invoiceDirection><invoiceQueryParams><mandatoryQueryParams><invoiceIssueDate><dateFrom>2026-09-01<\/dateFrom><dateTo>2026-09-30<\/dateTo>/);
  assert.match(seen[1]!, /<page>2<\/page>/);
});

test("an empty invoice list is an empty list", async () => {
  const { client } = clientAnswering(digestPage(1, 0, []));
  assert.deepEqual(await client.queryInvoiceDigest("2026-01-01", "2026-01-31"), []);
});
