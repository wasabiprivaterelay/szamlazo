import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { baseUrlOf, type NavCredentials, type NavEnvironment, type SoftwareDescription } from "./config.js";
import { buildRequest, type RequestOptions } from "./request.js";
import { decodeExchangeToken } from "./crypto.js";
import { element } from "./xml.js";
import { invoiceDataBase64, type NavInvoice } from "./invoice-xml.js";

/**
 * The HTTP side. Every operation posts XML and receives XML, always with HTTP
 * 200 when the request was well formed — a refusal arrives inside the body as
 * funcCode ERROR (specification 1.6.4), so a 200 alone means nothing and the
 * body is always read.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // NAV's elements are namespace-qualified; the prefixes carry no meaning for
  // a reader of the response, so they are dropped.
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

/** One line of NAV's invoice list. Amounts in forints. */
export type InvoiceDigest = {
  invoiceNumber: string;
  /** CREATE, STORNO or MODIFY. */
  operation: string;
  issueDate: string;
  netAmount: number;
  vatAmount: number;
  transactionId?: string;
  receivedAt: string;
};

export class NavError extends Error {
  constructor(
    message: string,
    readonly errorCode: string | undefined,
    readonly operation: string,
    readonly requestId: string,
    readonly validations: readonly string[] = [],
    readonly body?: string,
  ) {
    super(message);
    this.name = "NavError";
  }
}

export type NavClientOptions = {
  environment: NavEnvironment;
  credentials: NavCredentials;
  software: SoftwareDescription;
  /** Swapped in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
  /** Milliseconds before a request is given up on. */
  timeoutMs?: number;
};

export type NavResponse = Record<string, unknown>;

export class NavClient {
  private readonly baseUrl: string;

  constructor(private readonly options: NavClientOptions) {
    this.baseUrl = baseUrlOf(options.environment);
  }

  /** Posts one operation and returns its parsed body, or throws NavError. */
  async call(
    operation: string,
    request: Omit<RequestOptions, "credentials" | "software"> = {},
  ): Promise<NavResponse> {
    // The endpoint is camelCase and the root element is the same word with a
    // capital — /tokenExchange carries a TokenExchangeRequest. NAV rejects a
    // lowercase root with SCHEMA_VIOLATION, which is how this was found.
    const rootElement = `${operation[0]!.toUpperCase()}${operation.slice(1)}Request`;
    const built = buildRequest(rootElement, {
      ...request,
      credentials: this.options.credentials,
      software: this.options.software,
    });

    const endpoint = `${this.baseUrl}/${operation}`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/xml", accept: "application/xml" },
      body: built.xml,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    const text = await response.text();
    const parsed = parser.parse(text) as Record<string, NavResponse>;
    // The parser hands back the XML declaration alongside the root element, so
    // the body is the first entry that is not the declaration.
    const body =
      Object.entries(parsed).find(([name]) => !name.startsWith("?"))?.[1] ?? {};
    // A business answer keeps its status in <result>; a request NAV would not
    // even parse comes back as a GeneralExceptionResponse with the same fields
    // at the root. Both are read, so a refusal is never mistaken for silence.
    const result = {
      ...(body as Record<string, unknown>),
      ...((body.result ?? {}) as Record<string, unknown>),
    };

    if (!response.ok && result.funcCode === undefined) {
      throw new NavError(
        `${operation} failed with HTTP ${response.status}`,
        undefined,
        operation,
        built.requestId,
        [],
        text.slice(0, 2000),
      );
    }

    if (result.funcCode === "ERROR") {
      throw new NavError(
        String(result.message ?? `${operation} was refused`),
        result.errorCode === undefined ? undefined : String(result.errorCode),
        operation,
        built.requestId,
        validationsOf(body),
        text.slice(0, 2000),
      );
    }

    return body;
  }

  /**
   * A reporting token, decrypted. NAV encrypts it with the exchange key and
   * manageInvoice wants the plain value; the encrypted one authorises nothing.
   */
  async tokenExchange(): Promise<{ token: string; validFrom: string; validTo: string }> {
    const body = await this.call("tokenExchange");
    const encoded = body.encodedExchangeToken;
    if (typeof encoded !== "string") {
      throw new Error("tokenExchange answered without a token");
    }
    return {
      token: decodeExchangeToken(encoded, this.options.credentials.exchangeKey),
      validFrom: String(body.tokenValidityFrom ?? ""),
      validTo: String(body.tokenValidityTo ?? ""),
    };
  }

  /**
   * Reports invoices. Each one is signed on its own as well as with the
   * request (specification 1.5.1), so the token, the order and the base64
   * content must all agree. NAV answers with a transaction id and decides
   * what it thinks of the invoices afterwards.
   */
  async manageInvoice(
    invoices: readonly { operation: InvoiceOperation; invoice: NavInvoice }[],
  ): Promise<SubmissionResult> {
    if (invoices.length === 0) throw new Error("there is nothing to report");
    const { token } = await this.tokenExchange();

    const encoded = invoices.map((entry) => ({
      operation: entry.operation,
      base64: invoiceDataBase64(entry.invoice),
    }));

    const body = [
      element("exchangeToken", token),
      element("invoiceOperations", [
        element("compressedContent", "false"),
        ...encoded.map((entry, index) =>
          element("invoiceOperation", [
            element("index", String(index + 1)),
            element("invoiceOperation", entry.operation),
            element("invoiceData", entry.base64),
          ]),
        ),
      ]),
    ];

    const answer = await this.call("manageInvoice", { body, invoices: encoded });
    const transactionId = answer.transactionId;
    if (typeof transactionId !== "string") {
      throw new Error("manageInvoice answered without a transaction id");
    }
    return { transactionId };
  }

  /**
   * An invoice as NAV holds it: the XML it stored, decoded, and NAV's own
   * record of when it arrived, from which program and in which transaction.
   * The independent check that a report landed: not our log, NAV's copy.
   */
  async queryInvoiceData(
    invoiceNumber: string,
    direction: "OUTBOUND" | "INBOUND" = "OUTBOUND",
  ): Promise<StoredInvoice | null> {
    const answer = await this.call("queryInvoiceData", {
      body: [
        element("invoiceNumberQuery", [
          element("invoiceNumber", invoiceNumber),
          element("invoiceDirection", direction),
        ]),
      ],
    });

    const result = answer.invoiceDataResult as Record<string, unknown> | undefined;
    if (!result || typeof result.invoiceData !== "string") return null;

    const raw = Buffer.from(result.invoiceData, "base64");
    // NAV caps a request at 10 MB, so an invoice that inflates far beyond
    // that is not an invoice; the cap keeps a corrupt answer from eating memory.
    const xml = String(result.compressedContentIndicator) === "true"
      ? gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8")
      : raw.toString("utf8");
    const audit = (result.auditData ?? {}) as Record<string, unknown>;

    return {
      xml,
      receivedAt: String(audit.insdate ?? ""),
      technicalUser: String(audit.insCusUser ?? ""),
      source: String(audit.source ?? ""),
      transactionId: audit.transactionId === undefined ? undefined : String(audit.transactionId),
      requestVersion: String(audit.originalRequestVersion ?? ""),
    };
  }

  /**
   * NAV's list of the invoices issued between two dates, one line each with
   * its number, operation and amounts. The nightly check compares it with
   * ours both ways: an invoice NAV lacks was never reported, and one only
   * NAV has was reported by something other than this program. NAV answers a
   * page at a time and allows at most 35 days per question.
   */
  async queryInvoiceDigest(
    issuedFrom: string,
    issuedTo: string,
    direction: "OUTBOUND" | "INBOUND" = "OUTBOUND",
  ): Promise<InvoiceDigest[]> {
    const found: InvoiceDigest[] = [];
    for (let page = 1; ; page++) {
      const answer = await this.call("queryInvoiceDigest", {
        body: [
          element("page", String(page)),
          element("invoiceDirection", direction),
          element("invoiceQueryParams", [
            element("mandatoryQueryParams", [
              element("invoiceIssueDate", [element("dateFrom", issuedFrom), element("dateTo", issuedTo)]),
            ]),
          ]),
        ],
      });
      const result = (answer.invoiceDigestResult ?? {}) as Record<string, unknown>;
      for (const entry of asArray(result.invoiceDigest)) {
        const one = entry as Record<string, unknown>;
        found.push({
          invoiceNumber: String(one.invoiceNumber ?? ""),
          operation: String(one.invoiceOperation ?? ""),
          issueDate: String(one.invoiceIssueDate ?? ""),
          netAmount: Number(one.invoiceNetAmountHUF ?? one.invoiceNetAmount ?? 0),
          vatAmount: Number(one.invoiceVatAmountHUF ?? one.invoiceVatAmount ?? 0),
          transactionId: one.transactionId === undefined ? undefined : String(one.transactionId),
          receivedAt: String(one.insDate ?? ""),
        });
      }
      if (page >= Number(result.availablePage ?? 1)) return found;
    }
  }

  /**
   * What NAV knows about a Hungarian tax number: whether it exists and is
   * valid, and if so the taxpayer's registered name, full number, legal form
   * and addresses. Only the first eight digits are asked about; the other
   * three come back in the answer, which is how a mistyped VAT or county
   * digit is caught.
   */
  async queryTaxpayer(taxNumber: string): Promise<Taxpayer> {
    const taxpayerId = taxNumber.replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(taxpayerId)) throw new Error(`not a tax number: ${taxNumber}`);

    const answer = await this.call("queryTaxpayer", { body: [element("taxNumber", taxpayerId)] });
    const valid = String(answer.taxpayerValidity) === "true";
    const data = answer.taxpayerData as Record<string, unknown> | undefined;
    if (!valid || !data) return { valid: false, taxpayerId };

    const detail = (data.taxNumberDetail ?? {}) as Record<string, unknown>;
    const addressList = (data.taxpayerAddressList ?? {}) as Record<string, unknown>;
    const addresses = asArray(addressList.taxpayerAddressItem).map((entry) => {
      const item = entry as Record<string, unknown>;
      const address = (item.taxpayerAddress ?? {}) as Record<string, unknown>;
      const street = [address.streetName, address.publicPlaceCategory, address.number]
        .filter(Boolean)
        .join(" ");
      const rest = [
        address.building && `${address.building}. ép.`,
        address.staircase && `${address.staircase}. lph.`,
        address.floor && `${address.floor}. em.`,
        address.door && `${address.door}. ajtó`,
      ].filter(Boolean);
      return {
        type: String(item.taxpayerAddressType ?? "") as "HQ" | "SITE" | "BRANCH",
        postalCode: String(address.postalCode ?? ""),
        city: String(address.city ?? ""),
        address: [street, ...rest].join(" ").trim(),
      };
    });

    return {
      valid: true,
      taxpayerId,
      name: String(data.taxpayerName ?? ""),
      shortName: data.taxpayerShortName === undefined ? undefined : String(data.taxpayerShortName),
      vatCode: detail.vatCode === undefined ? undefined : String(detail.vatCode),
      countyCode: detail.countyCode === undefined ? undefined : String(detail.countyCode),
      incorporation: String(data.incorporation ?? "") as Incorporation,
      vatGroupMembership:
        data.vatGroupMembership === undefined ? undefined : String(data.vatGroupMembership),
      addresses,
      infoDate: answer.infoDate === undefined ? undefined : String(answer.infoDate),
    };
  }

  /** What became of a submission. NAV takes seconds to minutes to decide. */
  async queryTransactionStatus(transactionId: string): Promise<TransactionStatus> {
    const answer = await this.call("queryTransactionStatus", {
      body: [element("transactionId", transactionId)],
    });

    const list = (answer.processingResults ?? {}) as Record<string, unknown>;
    const results = asArray(list.processingResult).map((entry) => {
      const one = entry as Record<string, unknown>;
      return {
        index: Number(one.index ?? 0),
        status: String(one.invoiceStatus ?? "UNKNOWN"),
        messages: [
          ...validationsOf({ technicalValidationMessages: one.technicalValidationMessages }),
          ...businessMessagesOf(one.businessValidationMessages),
        ],
      };
    });

    return {
      // ABORTED is final too: it means NAV will not be taking this one.
      finished:
        results.length > 0 && results.every((one) => one.status === "DONE" || one.status === "ABORTED"),
      invoices: results,
    };
  }
}

function businessMessagesOf(value: unknown): string[] {
  return asArray(value).map((entry) => {
    const one = entry as Record<string, unknown>;
    return [one.validationResultCode, one.validationErrorCode, one.message]
      .filter(Boolean)
      .join(": ");
  });
}

export type InvoiceOperation = "CREATE" | "MODIFY" | "STORNO";

/** Company, sole trader, or a private person who holds a tax number. */
export type Incorporation = "ORGANIZATION" | "SELF_EMPLOYED" | "TAXABLE_PERSON";

export type Taxpayer =
  | { valid: false; taxpayerId: string }
  | {
      valid: true;
      taxpayerId: string;
      /** The registered name, which is what an invoice should carry. */
      name: string;
      shortName?: string;
      vatCode?: string;
      countyCode?: string;
      incorporation: Incorporation;
      /** Set when the taxpayer belongs to a VAT group. */
      vatGroupMembership?: string;
      /** HQ is the registered seat (székhely); SITE and BRANCH are others. */
      addresses: { type: "HQ" | "SITE" | "BRANCH"; postalCode: string; city: string; address: string }[];
      /** When NAV's record of them last changed. */
      infoDate?: string;
    };

export type StoredInvoice = {
  /** The invoice data exactly as NAV stored it. */
  xml: string;
  receivedAt: string;
  /** The technical user that sent it. */
  technicalUser: string;
  /** How it arrived: OSZ for the machine interface, WEB for the portal. */
  source: string;
  transactionId?: string;
  requestVersion: string;
};

export type SubmissionResult = { transactionId: string };

export type InvoiceStatus = {
  index: number;
  /** RECEIVED, PROCESSING, SAVED, DONE or ABORTED. */
  status: string;
  messages: string[];
};

export type TransactionStatus = {
  /** True once NAV has finished with every invoice in the batch. */
  finished: boolean;
  invoices: InvoiceStatus[];
};

/** NAV lists what it objected to; those messages are the useful part. */
function validationsOf(body: Record<string, unknown>): string[] {
  const result = (body.result ?? {}) as Record<string, unknown>;
  const raw = [
    ...asArray(body.technicalValidationMessages),
    ...asArray(result.technicalValidationMessages),
    ...asArray(body.invoiceValidationMessages),
  ];
  return raw.map((entry) => {
    const one = entry as Record<string, unknown>;
    return [one.validationResultCode, one.validationErrorCode, one.message]
      .filter(Boolean)
      .join(": ");
  });
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
