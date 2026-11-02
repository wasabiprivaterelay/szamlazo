import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";

/**
 * Where issued invoice PDFs are kept. A PDF is written once; the SHA-256
 * stored beside it in the database is what proves, years later, that the
 * file is the one that was issued.
 */

export type StoredPdf = { path: string; sha256: string; bytes: number };

export type InvoiceStore = {
  put(path: string, pdf: Uint8Array): Promise<StoredPdf>;
  get(path: string): Promise<Uint8Array>;
  /** Writes, reads back and removes a small probe, to prove the store works. */
  probe?(): Promise<void>;
};

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** invoices/2026/SZ2026-00042.pdf: the year first, so a folder stays small. */
export function invoicePath(invoiceNumber: string, year: number): string {
  if (!/^[A-Z]{1,8}\d{4}\/\d+$/.test(invoiceNumber)) {
    throw new Error(`not an invoice number this server issues: ${invoiceNumber}`);
  }
  return `invoices/${year}/${invoiceNumber.replace("/", "-")}.pdf`;
}

/** Only the paths invoicePath makes, so nothing outside the store can be named. */
const SAFE_PATH = /^(invoices\/\d{4}\/[A-Z]{1,8}\d{4}-\d+\.pdf|probe\/[a-f0-9]{16}\.txt)$/;

function checkPath(path: string): void {
  if (!SAFE_PATH.test(path)) throw new Error(`refusing an unexpected storage path: ${JSON.stringify(path)}`);
}

/**
 * A folder on the server's disk. Simple, and right for trying the server out
 * or a small business that backs the folder up; production is better served
 * by a bucket (docs/production.md explains why).
 */
export function localStore(directory: string): InvoiceStore {
  const root = resolve(directory);
  const full = (path: string) => {
    checkPath(path);
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error(`refusing a path outside the store: ${path}`);
    return target;
  };

  const store: InvoiceStore = {
    async put(path, pdf) {
      const target = full(path);
      await mkdir(dirname(target), { recursive: true, mode: 0o750 });
      // Written beside the target and renamed into place, so a crash halfway
      // never leaves a truncated PDF under an invoice's name.
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, pdf, { mode: 0o640, flag: "wx" });
      await rename(temporary, target);
      return { path, sha256: sha256Of(pdf), bytes: pdf.byteLength };
    },
    async get(path) {
      return new Uint8Array(await readFile(full(path)));
    },
    async probe() {
      const path = `probe/${randomBytes(8).toString("hex")}.txt`;
      const body = new TextEncoder().encode("szamlazo storage probe");
      await store.put(path, body);
      const back = await store.get(path);
      if (sha256Of(back) !== sha256Of(body)) throw new Error("the storage probe read back different bytes");
      await rm(full(path), { force: true });
    },
  };
  return store;
}

export type ObjectStoreConfig = {
  /** https://<account>.r2.cloudflarestorage.com, https://s3.eu-central-1.amazonaws.com, … */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

/**
 * Any S3-compatible bucket: Cloudflare R2, AWS S3, Backblaze B2, MinIO.
 * `fetch` is a parameter so the signing can be tested without a bucket.
 */
export function objectStore(config: ObjectStoreConfig, fetchImpl: typeof fetch = fetch): InvoiceStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region ?? "auto",
  });
  const base = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}`;

  const store: InvoiceStore = {
    async put(path, pdf) {
      checkPath(path);
      const request = await client.sign(`${base}/${path}`, {
        method: "PUT",
        // Copied into its own buffer: a typed array over a larger buffer is
        // not a body fetch will take.
        body: pdf.slice().buffer as ArrayBuffer,
        headers: {
          "content-type": path.endsWith(".pdf") ? "application/pdf" : "text/plain",
          // The bucket verifies this, so a corrupted upload fails rather than
          // silently storing something else.
          "x-amz-content-sha256": sha256Of(pdf),
        },
      });
      const response = await fetchImpl(request, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        throw new Error(`storing ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
      }
      return { path, sha256: sha256Of(pdf), bytes: pdf.byteLength };
    },
    async get(path) {
      checkPath(path);
      const request = await client.sign(`${base}/${path}`, { method: "GET" });
      const response = await fetchImpl(request, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`reading ${path} failed: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async probe() {
      const path = `probe/${randomBytes(8).toString("hex")}.txt`;
      const body = new TextEncoder().encode("szamlazo storage probe");
      await store.put(path, body);
      const back = await store.get(path);
      if (sha256Of(back) !== sha256Of(body)) throw new Error("the storage probe read back different bytes");
      const removal = await client.sign(`${base}/${path}`, { method: "DELETE" });
      await fetchImpl(removal, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    },
  };
  return store;
}

/** Keeps PDFs in memory, for tests. */
export function memoryStore(): InvoiceStore & { contents: Map<string, Uint8Array> } {
  const contents = new Map<string, Uint8Array>();
  return {
    contents,
    async put(path, pdf) {
      checkPath(path);
      contents.set(path, pdf);
      return { path, sha256: sha256Of(pdf), bytes: pdf.byteLength };
    },
    async get(path) {
      const found = contents.get(path);
      if (!found) throw new Error(`reading ${path} failed: not stored`);
      return found;
    },
    async probe() {},
  };
}

export function storeFromEnv(env: {
  STORAGE: "local" | "s3";
  STORAGE_DIR: string;
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_REGION: string;
}): InvoiceStore {
  if (env.STORAGE === "local") return localStore(env.STORAGE_DIR);
  return objectStore({
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    region: env.S3_REGION,
  });
}
