import {
  newRequestId,
  passwordHash,
  requestSignature,
  requestSignatureWithInvoices,
  requestTimestamp,
  type SignedInvoice,
} from "./crypto.js";
import { checkCredentials, checkSoftware, type NavCredentials, type SoftwareDescription } from "./config.js";
import { element, optional, writeXml, type XmlNode } from "./xml.js";

/**
 * The header every operation shares (specification 1.3): the request's own
 * identity, who is asking, and what program is asking. The namespaces and the
 * order of the elements are what the schemas demand, so they live here once.
 */

export const API_NS = "http://schemas.nav.gov.hu/OSA/3.0/api";
export const COMMON_NS = "http://schemas.nav.gov.hu/NTCA/1.0/common";
export const DATA_NS = "http://schemas.nav.gov.hu/OSA/3.0/data";

const REQUEST_VERSION = "3.0";
const HEADER_VERSION = "1.0";

export type RequestOptions = {
  credentials: NavCredentials;
  software: SoftwareDescription;
  /** Fixed in tests; otherwise now. */
  timestamp?: Date;
  requestId?: string;
  /** The invoices this request carries, which change how it is signed. */
  invoices?: readonly SignedInvoice[];
  /** Operation-specific elements, in the order the schema wants them. */
  body?: XmlNode[];
};

export type BuiltRequest = { xml: string; requestId: string; timestamp: Date };

export function buildRequest(operation: string, options: RequestOptions): BuiltRequest {
  const { credentials, software } = options;
  checkCredentials(credentials);
  checkSoftware(software);

  const timestamp = options.timestamp ?? new Date();
  const requestId = options.requestId ?? newRequestId(timestamp);
  const parts = { requestId, timestamp, signingKey: credentials.signingKey };

  const signature = options.invoices?.length
    ? requestSignatureWithInvoices(parts, options.invoices)
    : requestSignature(parts);

  const header = element("common:header", [
    element("common:requestId", requestId),
    element("common:timestamp", requestTimestamp(timestamp)),
    element("common:requestVersion", REQUEST_VERSION),
    element("common:headerVersion", HEADER_VERSION),
  ]);

  const user = element("common:user", [
    element("common:login", credentials.login),
    element("common:passwordHash", passwordHash(credentials.password), { cryptoType: "SHA-512" }),
    element("common:taxNumber", credentials.taxNumber),
    element("common:requestSignature", signature, { cryptoType: "SHA3-512" }),
  ]);

  const softwareNode = element(
    "software",
    optional([
      element("softwareId", software.softwareId),
      element("softwareName", software.softwareName),
      element("softwareOperation", software.softwareOperation),
      element("softwareMainVersion", software.softwareMainVersion),
      element("softwareDevName", software.softwareDevName),
      element("softwareDevContact", software.softwareDevContact),
      software.softwareDevCountryCode
        ? element("softwareDevCountryCode", software.softwareDevCountryCode)
        : undefined,
      software.softwareDevTaxNumber
        ? element("softwareDevTaxNumber", software.softwareDevTaxNumber)
        : undefined,
    ]),
  );

  const root = element(operation, [header, user, softwareNode, ...(options.body ?? [])], {
    xmlns: API_NS,
    "xmlns:common": COMMON_NS,
  });

  return { xml: writeXml(root), requestId, timestamp };
}
