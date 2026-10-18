// The Japanese stamp face (Noto Sans JP, the one the web uses), fetched on
// demand: it is ~5.8 MB, so the package doesn't ship it. The first value that
// needs it downloads the public static file from fenfill.com once (a plain GET:
// no auth, no query, no body, no form data), verifies the pinned sha256 and
// keeps it in <cacheDir>/fonts/ (the sweep never ages it out). Latin-only fills
// never call this.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import { JP_FACE_BYTES, JP_FACE_SHA256 } from "@/app/t/[template_id]/fillCore";

import { writeFileAtomic } from "./cache.js";
import { log } from "./log.js";
import { toArrayBuffer } from "./fonts.js";
import { USER_AGENT } from "./version.js";

export const DEFAULT_JP_FONT_URL = "https://fenfill.com/fonts/NotoSansJP-Regular.ttf";
export const JP_FONT_FILE = "NotoSansJP-Regular.ttf";
export const JP_FONT_TIMEOUT_MS = 30_000;

const IS_WIN = process.platform === "win32";

export type JpFontFailure = "network" | "http_status" | "hash_mismatch" | "timeout" | "too_large";

export class JpFontError extends Error {
  readonly reason: JpFontFailure;
  readonly status: number | undefined;
  constructor(reason: JpFontFailure, message: string, status?: number) {
    super(message);
    this.name = "JpFontError";
    this.reason = reason;
    this.status = status;
  }
}

export interface EnsureJpFaceOptions {
  cacheDir: string;
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}

/** Where the face is kept (and can be pre-seeded). */
export function jpFontPath(cacheDir: string): string {
  return join(cacheDir, "fonts", JP_FONT_FILE);
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const memo = new Map<string, Promise<ArrayBuffer>>();

/** The face's bytes, from the cache or downloaded once. Memoized per process
 *  (per cache dir + url); a failure clears the memo so a later call retries. */
export function ensureJpFace(o: EnsureJpFaceOptions): Promise<ArrayBuffer> {
  const url = o.url ?? DEFAULT_JP_FONT_URL;
  const key = `${o.cacheDir}\0${url}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const p = load({ ...o, url }).catch((e: unknown) => {
    memo.delete(key);
    throw e;
  });
  memo.set(key, p);
  return p;
}

async function load(o: EnsureJpFaceOptions & { url: string }): Promise<ArrayBuffer> {
  const path = jpFontPath(o.cacheDir);
  try {
    const buf = await fsp.readFile(path);
    if (sha256(buf) === JP_FACE_SHA256) return toArrayBuffer(buf);
    await fsp.rm(path, { force: true });
  } catch {
    // Missing or unreadable: download it.
  }
  const bytes = await download(o);
  if (bytes.byteLength !== JP_FACE_BYTES || sha256(bytes) !== JP_FACE_SHA256) {
    throw new JpFontError("hash_mismatch", "The downloaded font doesn't match its pinned sha256.");
  }
  try {
    await writeFont(path, bytes);
  } catch (e) {
    // A read-only or full cache dir must not refuse the fill: keep the verified
    // bytes (memoized for this process) and say so once, on stderr.
    log("warn", "could not cache the Japanese font; using it for this session only", {
      error: errText(e),
    });
  }
  return toArrayBuffer(bytes);
}

async function download(o: EnsureJpFaceOptions & { url: string }): Promise<Uint8Array> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, o.timeoutMs ?? JP_FONT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(o.url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: ctl.signal,
      });
    } catch (e) {
      if (timedOut) throw new JpFontError("timeout", "The font download timed out.");
      throw new JpFontError("network", `The font download failed: ${errText(e)}`);
    }
    if (!res.ok) {
      throw new JpFontError(
        "http_status",
        `The font download returned HTTP ${res.status}.`,
        res.status,
      );
    }
    if (!sameHttpsHost(o.url, res)) {
      await res.body?.cancel().catch(() => undefined);
      throw new JpFontError("http_status", "The font download was redirected to another host.");
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared !== JP_FACE_BYTES) {
      ctl.abort();
      if (declared > JP_FACE_BYTES) {
        throw new JpFontError("too_large", "The font download is larger than expected.");
      }
      throw new JpFontError(
        "hash_mismatch",
        "The downloaded font doesn't match its pinned sha256.",
      );
    }
    try {
      return await readCapped(res, ctl);
    } catch (e) {
      if (e instanceof JpFontError) throw e;
      if (timedOut) throw new JpFontError("timeout", "The font download timed out.");
      throw new JpFontError("network", `The font download failed: ${errText(e)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Refuse a redirect off the requested host (or to plain http). A response
 *  without a url (test mocks) counts as fine. */
function sameHttpsHost(requested: string, res: Response): boolean {
  if (!res.url) return !res.redirected;
  try {
    const a = new URL(requested);
    const b = new URL(res.url);
    return b.protocol === "https:" && b.host === a.host;
  } catch {
    return false;
  }
}

async function readCapped(res: Response, ctl: AbortController): Promise<Uint8Array> {
  const tooLarge = () => {
    ctl.abort();
    return new JpFontError("too_large", "The font download is larger than expected.");
  };
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.byteLength > JP_FACE_BYTES) throw tooLarge();
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > JP_FACE_BYTES) {
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

async function writeFont(path: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(path);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) await fsp.chmod(dir, 0o700);
  await writeFileAtomic(path, bytes, 0o600);
}

function errText(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
  return e instanceof Error ? `${e.message}${cause}` : String(e);
}

/** A short reason for the agent's hint. */
export function jpFontReason(e: unknown): string {
  if (!(e instanceof JpFontError)) return errText(e);
  switch (e.reason) {
    case "network":
      return "network error";
    case "timeout":
      return "the download timed out";
    case "http_status":
      return `HTTP ${String(e.status)}`;
    case "hash_mismatch":
      return "the file didn't match its pinned checksum";
    case "too_large":
      return "the download was larger than expected";
  }
}
