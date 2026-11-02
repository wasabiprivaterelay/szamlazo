/**
 * Who we are to NAV, and which of its two systems we are talking to. The test
 * system has its own registration, its own technical users and its own keys;
 * neither set works against the other, so the environment is part of the
 * configuration rather than a flag somewhere.
 */

export type NavEnvironment = "test" | "production";

const BASE_URLS: Record<NavEnvironment, string> = {
  test: "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3",
  production: "https://api.onlineszamla.nav.gov.hu/invoiceService/v3",
};

export function baseUrlOf(environment: NavEnvironment): string {
  return BASE_URLS[environment];
}

/** The four values the portal shows when a technical user is created. */
export type NavCredentials = {
  login: string;
  password: string;
  signingKey: string;
  exchangeKey: string;
  /** The first eight digits of the taxpayer's number. */
  taxNumber: string;
};

/**
 * Every request must say which program sent it (specification 1.3.3). The
 * values are the sender's to choose, but the shapes are not: the id is
 * exactly 18 characters of capitals, digits and hyphens, and the operation is
 * one of two words.
 */
export type SoftwareDescription = {
  softwareId: string;
  softwareName: string;
  softwareOperation: "LOCAL_SOFTWARE" | "ONLINE_SERVICE";
  softwareMainVersion: string;
  softwareDevName: string;
  softwareDevContact: string;
  softwareDevCountryCode?: string;
  softwareDevTaxNumber?: string;
};

export function checkCredentials(credentials: NavCredentials): void {
  const complain = (what: string) => {
    throw new Error(`the NAV credentials are not usable: ${what}`);
  };
  if (!/^[a-zA-Z0-9]{6,15}$/.test(credentials.login)) complain("the login is not 6-15 letters or digits");
  if (credentials.password === "") complain("the password is empty");
  if (credentials.signingKey === "") complain("the signing key is empty");
  // AES-128 takes a 16-byte key, and NAV issues exactly that.
  if (Buffer.byteLength(credentials.exchangeKey, "utf8") !== 16) {
    complain("the exchange key is not 16 bytes");
  }
  if (!/^\d{8}$/.test(credentials.taxNumber)) complain("the tax number is not eight digits");
}

export function checkSoftware(software: SoftwareDescription): void {
  if (!/^[0-9A-Z-]{18}$/.test(software.softwareId)) {
    throw new Error(
      `softwareId must be exactly 18 characters of A-Z, 0-9 and -, got "${software.softwareId}"`,
    );
  }
  for (const [field, value] of Object.entries(software)) {
    if (typeof value === "string" && value.trim() === "") {
      throw new Error(`${field} is required in the software block`);
    }
  }
}
