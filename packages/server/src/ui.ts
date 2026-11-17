import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The web page: one file of HTML with its style and script inside, read once
 * from beside this module (src/ in development, dist/ once built). Each
 * response gets a fresh nonce, and the Content-Security-Policy lets only that
 * script and style run, so nothing an invoice contains could ever execute.
 */

let template: string | undefined;

export function uiPage(): { html: string; csp: string } {
  template ??= readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  const nonce = randomBytes(16).toString("base64");
  return {
    html: template.replaceAll("__NONCE__", nonce),
    csp: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "frame-src blob:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
