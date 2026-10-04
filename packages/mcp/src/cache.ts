// The on-disk cache under FENFILL_CACHE_DIR. Directories 0700, files 0600.
//
// PRIVACY: this cache holds ONLY schemas, blank forms, the workspace
// logo, job bookkeeping and sha256 digests of produced outputs. Never a fill
// value passed to a tool, never a filled PDF or preview image, never the API
// key (only a truncated hash of it). The edits/ working copies hold layout
// plus whatever wording the AGENT wrote with edit_template (labels,
// descriptions, placeholders, option text, date formats, checkbox symbols).
// The echo guard (echo.ts) refuses, before anything is written here, any such
// wording that repeats an answer filled in THIS session (its list lives in
// memory only and is never written here); it can't know answers from other
// sessions, so save_template asks the agent to confirm wording that an earlier
// process wrote (`writer`).
// Layout:
//
//   forms/<sha256>/<pagesKey>.<u|s-<template id>>.json
//                                       one finished analysis of a blank PDF
//                                       (unsaved, or saved as that template)
//   pending/<sha256>.<optsHash>.json    the analyze lock / in-progress job
//   templates/<id>/blank.pdf            a template's blank PDF (1 h TTL)
//   account/<workspace_id>/logo.bin     the workspace branding logo (1 h TTL)
//   outputs/<sha256>                    marker: a PDF this server produced
//   edits/<t-<template id>|f-<sha256>>.json
//                                       edit_template's working copy of a
//                                       template's (or an unsaved analysis's)
//                                       render schema, until saved or discarded

import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentSchema, RenderSchema } from "./types.js";

export const ASSET_TTL_MS = 60 * 60 * 1000;
export const STALE_LOCK_MS = 10 * 60 * 1000;
/** A job's result lives at most 24 h server-side, so its pending entry does too. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const IS_WIN = process.platform === "win32";

export interface AnalyzeOptions {
  /** Canonical page spec ("1-3,5"), or null for "every page". */
  pages: string | null;
  save_as_template: boolean;
  /** A saved template's access when restricted (save_as_template only).
   *  Absent = public, so entries written before it existed keep their hash. */
  access?: "restricted";
  /** AcroForm + a vision pass for blanks without a native field (paid per
   *  selected page). Present only when true, so older entries keep their hash. */
  detect_extra_blanks?: true;
}

/** The access a saving request asks for (public unless restricted). */
export const accessOf = (o: AnalyzeOptions): "public" | "restricted" =>
  o.access === "restricted" ? "restricted" : "public";

/** The fenfill account an API key belongs to. Never the key itself. */
export interface AccountFingerprint {
  /** From GET /v1/account, when it could be read. */
  workspace_id: string | null;
  /** A truncated sha256 of the key: identifies it, can't be turned back into it. */
  key_sha: string;
}

/** Which API (FENFILL_API_URL) and account a cache entry belongs to. */
export interface ApiIdentity {
  api_origin: string;
  account: AccountFingerprint;
}

/** Entries recorded under an identity. Missing fields (older entries) never match. */
export interface IdentityTagged {
  api_origin?: string;
  account?: AccountFingerprint;
}

export interface CachedAnalysis extends IdentityTagged {
  v: 1;
  sha256: string;
  options: AnalyzeOptions;
  job_id: string;
  template_id: string | null;
  mode: "ai" | "acroform";
  cost: number;
  /** The pages this job actually analyzed (the job's `pages`). */
  pages: number[];
  /** The local PDF's page count (null if it couldn't be read). */
  page_count: number | null;
  render: RenderSchema;
  agent: AgentSchema;
  /** ISO time the result was fetched: the newest analysis of a page wins. */
  at: string;
  /** ISO time a cache hit last showed this analysis ALONE (a template view):
   *  it then counts as the newest, so fill_form fills what the agent saw. */
  served_at?: string;
  /** AcroForm jobs: the server's free hint that blanks without a native field
   *  are likely (detect_extra_blanks would find them). */
  extra_blanks_available?: boolean;
  /** AcroForm + detect_extra_blanks (reported mode "ai"): the pages the paid
   *  vision pass covered (the 202's list). `pages` stays every native-field page;
   *  only these were scanned for extra blanks. Absent on other jobs. */
  extra_blanks_pages?: number[];
}

/** The server instance that wrote a working copy (see WorkingCopy.writer). */
export interface EditWriter {
  pid: number;
  /** ISO start time of the writing server instance. */
  started_at: string;
  /** Its random per-instance id (analyze.ts LIVE_OWNERS). */
  owner: string;
}

/** edit_template's local working copy of one target's render schema. */
export interface WorkingCopy extends IdentityTagged {
  v: 1;
  /** "t-<template id>" or "f-<sha256 of the blank PDF>". */
  key: string;
  template_id: string | null;
  /** The blank PDF a file target was analyzed from. */
  sha256: string | null;
  /** The template version the edits started from (save's expected_updated_at). */
  base_updated_at: string | null;
  /** The schema the edits started from (what save compares wording against). */
  base: RenderSchema;
  /** The edited schema. */
  render: RenderSchema;
  created_at: string;
  updated_at: string;
  /** Ops applied so far, over every edit_template call. */
  ops_applied: number;
  /** The server instance that last wrote it. Only that instance's echo guard
   *  has checked its wording; absent on copies written before it existed. */
  writer?: EditWriter;
  /** Set (and kept) once an instance takes over a copy whose changed wording
   *  another instance wrote: save_template then needs confirm_wording. */
  inherited_wording?: true;
}

const EDIT_KEY = /^(?:t-[A-Za-z0-9_-]{1,64}|f-[0-9a-f]{64})$/;

export function editKeyForTemplate(templateId: string): string {
  assertSafeId(templateId);
  return `t-${templateId}`;
}

export function editKeyForFile(sha: string): string {
  assertSha(sha);
  return `f-${sha}`;
}

export interface PendingEntry extends IdentityTagged {
  v: 1;
  sha256: string;
  options: AnalyzeOptions;
  created_at: string;
  pid: number;
  /** The holding server instance (see analyze.ts LIVE_OWNERS). */
  owner?: string;
  /** Random per lock: a holder only ever deletes its own entry. */
  token?: string;
  job_id?: string;
  pages?: number[];
  mode?: "ai" | "acroform";
  cost?: number;
  /** The 202's free AcroForm hint (only the accept response carries it). */
  extra_blanks_available?: boolean;
  /** The 202's extra_blanks_pages (only the accept response carries it). */
  extra_blanks_pages?: number[];
  /** Started by `force`: a plain call waits for it rather than serve the cache it replaces. */
  forced?: boolean;
  /** The POST failed mid-flight: a job may exist. Honoured for 10 minutes from `failed_at`. */
  unknown_outcome?: boolean;
  failed_at?: string;
  /** Consecutive polls that failed without a retryable cause (3 drop the entry). */
  poll_errors?: number;
}

/** Identifies one version of one file, for a compare-and-delete. */
export interface FileStamp {
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
}

export interface PendingRead {
  optsHash: string;
  /** null: unreadable, or caught between its O_EXCL create and its first write. */
  entry: PendingEntry | null;
  /** ms since the lock was created (created_at, else the file's mtime). */
  ageMs: number;
  stamp: FileStamp;
}

/** Which pending entry a removal targets: the exact file version read, or the
 *  entry holding this lock token or job id. Anything else is left in place. */
export type PendingMatch = { stamp: FileStamp } | { token: string } | { job_id: string };

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A key's fingerprint half: domain-separated, truncated, one-way. */
export function keyFingerprint(apiKey: string): string {
  return sha256Hex(`fenfill-mcp/account\n${apiKey}`).slice(0, 16);
}

/**
 * Is an entry the same API and account as `who`? The workspace id decides when
 * both sides know it (a rotated key still matches); otherwise the key hash does.
 * An entry without these fields (written by an older version) never matches.
 */
export function sameAccount(
  e: IdentityTagged | null | undefined,
  who: ApiIdentity | null,
): boolean {
  if (!e || !who || typeof e.api_origin !== "string" || e.api_origin !== who.api_origin) {
    return false;
  }
  const a = e.account;
  if (!a || typeof a !== "object") return false;
  if (typeof a.workspace_id === "string" && a.workspace_id && who.account.workspace_id) {
    return a.workspace_id === who.account.workspace_id;
  }
  return typeof a.key_sha === "string" && a.key_sha === who.account.key_sha;
}

/** The lock-file key for (options, API + key): other accounts never share a lock. */
export function optionsHash(o: AnalyzeOptions, who: ApiIdentity | null = null): string {
  const scope = who ? { o: who.api_origin, k: who.account.key_sha } : {};
  const acc = o.access === "restricted" ? { a: "restricted" } : {};
  const extra = o.detect_extra_blanks === true ? { x: true } : {};
  return sha256Hex(
    JSON.stringify({ p: o.pages, s: o.save_as_template, ...acc, ...extra, ...scope }),
  ).slice(0, 16);
}

/** Pages → canonical ranges, e.g. [1,2,3,5] → "1-3,5". */
export function pagesToSpec(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${String(sorted[i])}-${String(sorted[j])}`);
    i = j + 1;
  }
  return parts.join(",");
}

function pagesKey(pages: readonly number[]): string {
  const spec = pagesToSpec(pages).replace(/,/g, "_");
  return spec.length <= 120 ? `p${spec}` : `h${sha256Hex(spec).slice(0, 32)}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("unsafe cache id");
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error("bad sha256");
}

/** The valid extra_blanks_pages of an entry, or null (absent / empty / junk). */
export function extraBlanksPagesOf(e: { extra_blanks_pages?: unknown }): number[] | null {
  const x = e.extra_blanks_pages;
  if (!Array.isArray(x)) return null;
  const pages = x.filter((p): p is number => Number.isInteger(p) && (p as number) > 0);
  return pages.length ? [...new Set(pages)].sort((a, b) => a - b) : null;
}

/**
 * An analysis's file name. A saved analysis is keyed by its template, so a
 * later unsaved analysis of the same pages never overwrites it; an
 * extra-blank pass is keyed by its scanned pages too (`.e-<pagesKey>`), so
 * passes over different pages of one AcroForm PDF keep each other. Entries
 * without one keep their old name. (Older names, `<pagesKey>.json`, are still
 * read.)
 */
export function analysisName(entry: CachedAnalysis): string {
  const tpl = entry.template_id;
  const kind = !tpl ? "u" : SAFE_ID.test(tpl) ? `s-${tpl}` : `s-${sha256Hex(tpl).slice(0, 32)}`;
  const extra = extraBlanksPagesOf(entry);
  return `${pagesKey(entry.pages)}${extra ? `.e-${pagesKey(extra)}` : ""}.${kind}.json`;
}

async function mkdirSecure(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) await fsp.chmod(dir, 0o700);
}

/** Write via a same-directory temp file + rename, so readers never see a torn file. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "wx", mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, path);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function stampMatches(
  m: PendingMatch,
  st: { dev: number; ino: number; mtimeMs: number },
  raw: string,
): boolean {
  if ("stamp" in m) {
    const s = m.stamp;
    return st.dev === s.dev && st.ino === s.ino && st.mtimeMs === s.mtimeMs && raw === s.raw;
  }
  const e = parseJson<PendingEntry>(raw);
  if (!e || typeof e !== "object") return false;
  return "token" in m ? e.token === m.token : e.job_id === m.job_id;
}

export class Cache {
  readonly root: string;
  private readonly now: () => number;

  constructor(root: string, now: () => number = Date.now) {
    this.root = root;
    this.now = now;
  }

  private async dir(...parts: string[]): Promise<string> {
    await mkdirSecure(this.root);
    let d = this.root;
    for (const p of parts) {
      d = join(d, p);
      await mkdirSecure(d);
    }
    return d;
  }

  // ---- analyses ----------------------------------------------------------------

  async listAnalyses(sha: string): Promise<CachedAnalysis[]> {
    assertSha(sha);
    const d = join(this.root, "forms", sha);
    let names: string[];
    try {
      names = await fsp.readdir(d);
    } catch {
      return [];
    }
    const out: CachedAnalysis[] = [];
    for (const n of names.sort()) {
      if (!n.endsWith(".json") || n.startsWith(".")) continue;
      const e = await readJson<CachedAnalysis>(join(d, n));
      if (
        e &&
        e.v === 1 &&
        e.sha256 === sha &&
        Array.isArray(e.pages) &&
        e.render &&
        typeof e.render === "object" &&
        e.agent &&
        Array.isArray(e.agent.fields)
      ) {
        out.push(e);
      }
    }
    return out;
  }

  /** Every blank PDF with cached analyses. */
  async formShas(): Promise<string[]> {
    try {
      return (await fsp.readdir(join(this.root, "forms"))).filter((n) => SHA_RE.test(n)).sort();
    } catch {
      return [];
    }
  }

  async saveAnalysis(entry: CachedAnalysis): Promise<void> {
    assertSha(entry.sha256);
    const d = await this.dir("forms", entry.sha256);
    await writeFileAtomic(join(d, analysisName(entry)), JSON.stringify(entry));
  }

  /** Mark a form's analyses as used now (the sweep drops forms unused for 90 days). */
  async touchForm(sha: string): Promise<void> {
    assertSha(sha);
    const d = join(this.root, "forms", sha);
    const t = this.now() / 1000;
    try {
      for (const n of await fsp.readdir(d)) {
        if (n.endsWith(".json") && !n.startsWith(".")) await fsp.utimes(join(d, n), t, t);
      }
    } catch {
      // best effort
    }
  }

  // ---- pending (the analyze lock) ----------------------------------------------------

  private pendingPath(sha: string, optsHash: string): string {
    assertSha(sha);
    if (!/^[0-9a-f]{16}$/.test(optsHash)) throw new Error("bad options hash");
    return join(this.root, "pending", `${sha}.${optsHash}.json`);
  }

  /** Take the lock with O_EXCL. false = someone else holds it. */
  async tryCreatePending(entry: PendingEntry, optsHash: string): Promise<boolean> {
    await this.dir("pending");
    const p = this.pendingPath(entry.sha256, optsHash);
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(p, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    try {
      await fh.writeFile(JSON.stringify(entry));
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }

  /**
   * The pending entry, or null. A lock file caught between its O_EXCL create and
   * its first write reads as a fresh lock without a job id.
   */
  async readPending(sha: string, optsHash: string): Promise<PendingRead | null> {
    const p = this.pendingPath(sha, optsHash);
    let st;
    let raw: string;
    try {
      st = await fsp.stat(p);
      raw = await fsp.readFile(p, "utf8");
    } catch {
      return null;
    }
    const parsed = parseJson<PendingEntry>(raw);
    const entry = parsed && typeof parsed === "object" && parsed.v === 1 ? parsed : null;
    const created = entry?.created_at ? Date.parse(entry.created_at) : NaN;
    const born = Number.isFinite(created) ? created : st.mtimeMs;
    return {
      optsHash,
      entry,
      ageMs: this.now() - born,
      stamp: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, raw },
    };
  }

  /** Every pending entry for one blank PDF, whatever its options or account. */
  async listPending(sha: string): Promise<PendingRead[]> {
    assertSha(sha);
    let names: string[];
    try {
      names = await fsp.readdir(join(this.root, "pending"));
    } catch {
      return [];
    }
    const out: PendingRead[] = [];
    const re = new RegExp(`^${sha}\\.([0-9a-f]{16})\\.json$`);
    for (const n of names.sort()) {
      const m = re.exec(n);
      if (!m) continue;
      const r = await this.readPending(sha, m[1]);
      if (r) out.push(r);
    }
    return out;
  }

  async updatePending(entry: PendingEntry, optsHash: string): Promise<void> {
    await this.dir("pending");
    await writeFileAtomic(this.pendingPath(entry.sha256, optsHash), JSON.stringify(entry));
  }

  /**
   * Remove a pending entry only if it is still the one meant (compare-and-delete).
   * The file is first moved to a unique tombstone, so what is checked is exactly
   * what is deleted; a different (newer) entry is put back, unless an even newer
   * one has taken the path meanwhile. true = removed.
   */
  async removePending(sha: string, optsHash: string, match: PendingMatch): Promise<boolean> {
    const p = this.pendingPath(sha, optsHash);
    const tomb = join(dirname(p), `.${randomBytes(8).toString("hex")}.tomb`);
    try {
      await fsp.rename(p, tomb);
    } catch {
      return false; // already gone
    }
    let same = false;
    try {
      const st = await fsp.stat(tomb);
      same = stampMatches(match, st, await fsp.readFile(tomb, "utf8"));
    } catch {
      same = false;
    }
    if (!same) {
      try {
        await fsp.link(tomb, p);
      } catch (e) {
        // EEXIST: a newer entry took the path, and it wins. Without hard links,
        // move it back while the path is still free.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          const free = await fsp.stat(p).then(
            () => false,
            () => true,
          );
          if (free) await fsp.rename(tomb, p).catch(() => undefined);
        }
      }
    }
    await fsp.rm(tomb, { force: true });
    return same;
  }

  // ---- blank template PDFs + the logo (1 h TTL) ----------------------------------------

  private async readFresh(path: string, maxAgeMs: number): Promise<Uint8Array | null> {
    try {
      const st = await fsp.stat(path);
      const age = this.now() - st.mtimeMs;
      if (age > maxAgeMs || age < -maxAgeMs) return null;
      return new Uint8Array(await fsp.readFile(path));
    } catch {
      return null;
    }
  }

  /** Write an asset and stamp its mtime with our clock (the TTL reads mtime). */
  private async writeAsset(path: string, data: Uint8Array): Promise<void> {
    await writeFileAtomic(path, data);
    const t = this.now() / 1000;
    await fsp.utimes(path, t, t);
  }

  async readBlank(templateId: string, maxAgeMs = ASSET_TTL_MS): Promise<Uint8Array | null> {
    assertSafeId(templateId);
    return this.readFresh(join(this.root, "templates", templateId, "blank.pdf"), maxAgeMs);
  }

  async writeBlank(templateId: string, pdf: Uint8Array): Promise<void> {
    assertSafeId(templateId);
    const d = await this.dir("templates", templateId);
    await this.writeAsset(join(d, "blank.pdf"), pdf);
  }

  async readLogo(workspaceId: string, maxAgeMs = ASSET_TTL_MS): Promise<Uint8Array | null> {
    assertSafeId(workspaceId);
    return this.readFresh(join(this.root, "account", workspaceId, "logo.bin"), maxAgeMs);
  }

  async writeLogo(workspaceId: string, logo: Uint8Array): Promise<void> {
    assertSafeId(workspaceId);
    const d = await this.dir("account", workspaceId);
    await this.writeAsset(join(d, "logo.bin"), logo);
  }

  // ---- edits (edit_template working copies) --------------------------------------------

  private editPath(key: string): string {
    if (!EDIT_KEY.test(key)) throw new Error("unsafe edit key");
    return join(this.root, "edits", `${key}.json`);
  }

  async readEdits(key: string): Promise<WorkingCopy | null> {
    const e = await readJson<WorkingCopy>(this.editPath(key));
    if (
      !e ||
      e.v !== 1 ||
      e.key !== key ||
      !e.render ||
      typeof e.render !== "object" ||
      !Array.isArray(e.render.fields) ||
      !e.base ||
      typeof e.base !== "object"
    ) {
      return null;
    }
    return e;
  }

  async writeEdits(wc: WorkingCopy): Promise<void> {
    const p = this.editPath(wc.key);
    await this.dir("edits");
    await writeFileAtomic(p, JSON.stringify(wc));
    const t = this.now() / 1000;
    await fsp.utimes(p, t, t).catch(() => undefined);
  }

  /** true = a working copy was removed. */
  async deleteEdits(key: string): Promise<boolean> {
    const p = this.editPath(key);
    try {
      await fsp.rm(p);
      return true;
    } catch {
      return false;
    }
  }

  // ---- outputs registry --------------------------------------------------------------

  async registerOutput(sha: string): Promise<void> {
    assertSha(sha);
    const d = await this.dir("outputs");
    await writeFileAtomic(join(d, sha), "");
  }

  async isRegisteredOutput(sha: string): Promise<boolean> {
    assertSha(sha);
    try {
      await fsp.stat(join(this.root, "outputs", sha));
      return true;
    } catch {
      return false;
    }
  }
}
