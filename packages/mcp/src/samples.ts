// list_sample_forms' `download`: one of fenfill's sample forms saved on this
// machine, for an agent whose client has no download tool of its own (Claude
// Desktop), so a test key's analyze_form can be given a path. The file is a
// public static PDF on fenfill's site: a plain GET of the pdf_url fenfill
// listed for that sample (no API key, no query, no body, no form data), held to
// that URL's origin (a redirect is refused), capped at the listed size while it
// streams and kept only if its SHA-256 is the listed one, at
// <cacheDir>/samples/<slug>-<sha12>.pdf. A file already there is reused while
// its hash still matches; the sweep never ages one out (only a crashed write's
// temp file).

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex, writeFileAtomic } from "./cache.js";
import { ToolError } from "./errors.js";
import type { Sample } from "./types.js";
import { USER_AGENT } from "./version.js";

export const SAMPLE_TIMEOUT_MS = 60_000;
/** How far past its listed size a download may run before it is cut off (a
 *  file that differs by less fails its hash check instead). */
export const SAMPLE_SLACK_BYTES = 4096;
/** No sample is larger (the library's are a few MB). */
export const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;

const IS_WIN = process.platform === "win32";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface SampleDownloadOptions {
  cacheDir: string;
  /** The package's injected fetch (the API client's), so tests can mock it. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Where a sample is kept: one file per slug and content hash. */
export function samplePath(cacheDir: string, s: { slug: string; sha256: string }): string {
  return join(cacheDir, "samples", `${s.slug}-${s.sha256.slice(0, 12)}.pdf`);
}

function badListing(what: string): ToolError {
  return new ToolError("bad_response", `fenfill listed this sample with an unusable ${what}.`, {
    hint: "Retry shortly, or pick another sample from list_sample_forms.",
  });
}

const isLoopback = (h: string) => {
  const host = h.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
  );
};

/** The listed pdf_url, if it is one we fetch: https (http on a loopback host only), no credentials. */
function pdfUrlOf(raw: unknown): URL {
  if (typeof raw !== "string") throw badListing("pdf_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badListing("pdf_url");
  }
  const httpOk = url.protocol === "http:" && isLoopback(url.hostname);
  if ((url.protocol !== "https:" && !httpOk) || url.username || url.password) {
    throw new ToolError(
      "sample_download_refused",
      "This sample's pdf_url isn't an https address, so it wasn't downloaded.",
      { hint: "Pick another sample from list_sample_forms." },
    );
  }
  return url;
}

/** The listed file, already on disk with the listed hash? A stale or broken copy is removed. */
async function haveVerified(path: string, sha256: string, bytes: number): Promise<boolean> {
  let st;
  try {
    st = await fsp.lstat(path);
  } catch {
    return false;
  }
  if (st.isFile() && st.size === bytes) {
    try {
      if (sha256Hex(new Uint8Array(await fsp.readFile(path))) === sha256) return true;
    } catch {
      // unreadable: replace it
    }
  }
  await fsp.rm(path, { force: true, recursive: true });
  return false;
}

function failed(message: string, details: Record<string, unknown> = {}): ToolError {
  return new ToolError("sample_download_failed", message, {
    hint: "Check the internet connection and retry, or download the file from pdf_url yourself and pass that file to analyze_form unchanged.",
    details,
  });
}

function tooLarge(): ToolError {
  return new ToolError(
    "sample_too_large",
    "The download is larger than the sample's listed size, so it was stopped and nothing was saved.",
    { hint: "Retry shortly; if it persists, pick another sample from list_sample_forms." },
  );
}

/** The body, read as it streams and cut off past `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.byteLength > cap) throw tooLarge();
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Save `sample` (an entry of GET /v1/samples) under `<cacheDir>/samples/` and
 * return its absolute path; `cached` when a verified copy was already there.
 * Nothing is written unless the downloaded bytes hash to the listed sha256.
 */
export async function downloadSample(
  sample: Sample,
  o: SampleDownloadOptions,
): Promise<{ path: string; cached: boolean }> {
  if (typeof sample.slug !== "string" || !SLUG_RE.test(sample.slug)) throw badListing("slug");
  if (typeof sample.sha256 !== "string" || !SHA_RE.test(sample.sha256)) {
    throw badListing("sha256");
  }
  const size = sample.bytes;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SAMPLE_BYTES) {
    throw badListing("size");
  }
  const url = pdfUrlOf(sample.pdf_url);
  const path = samplePath(o.cacheDir, sample);
  if (await haveVerified(path, sample.sha256, size)) return { path, cached: true };

  const timeout = AbortSignal.timeout(o.timeoutMs ?? SAMPLE_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const cap = size + SAMPLE_SLACK_BYTES;
  const why = (e: unknown): ToolError => {
    if (e instanceof ToolError) return e;
    if (o.signal?.aborted) return new ToolError("cancelled", "The request was cancelled.");
    if (timeout.aborted) return failed("The sample's download timed out.");
    return failed(`Couldn't download the sample from ${url.origin}.`);
  };
  let pdf: Uint8Array;
  try {
    // A public static file: no Authorization header (the API key stays with
    // the API), and no redirect is followed.
    const res = await fetchImpl(url.href, {
      method: "GET",
      headers: { Accept: "application/pdf", "User-Agent": USER_AGENT },
      redirect: "error",
      signal,
    });
    let finalOrigin: string | null = url.origin;
    if (res.url) {
      try {
        finalOrigin = new URL(res.url).origin;
      } catch {
        finalOrigin = null;
      }
    }
    if (finalOrigin !== url.origin || (res.redirected && !res.url)) {
      await res.body?.cancel().catch(() => undefined);
      throw new ToolError(
        "sample_download_refused",
        `The sample's download left ${url.origin}, so it was refused and nothing was saved.`,
        { hint: "Retry shortly; if it persists, pick another sample from list_sample_forms." },
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw failed(`The sample's download returned HTTP ${String(res.status)}.`, {
        status: res.status,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > cap) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    pdf = await readCapped(res, cap);
  } catch (e) {
    throw why(e);
  }
  if (pdf.byteLength !== size || sha256Hex(pdf) !== sample.sha256) {
    throw new ToolError(
      "sample_hash_mismatch",
      "The downloaded file doesn't match the sample's sha256, so nothing was saved.",
      { hint: "Retry shortly; if it persists, pick another sample from list_sample_forms." },
    );
  }
  const dir = dirname(path);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) await fsp.chmod(dir, 0o700);
  await writeFileAtomic(path, pdf, 0o600);
  return { path, cached: false };
}
