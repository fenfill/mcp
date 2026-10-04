// analyze_form: refuse filled PDFs → serve from cache → resume a pending job →
// else lock, POST once, and poll within the wait budget.
//
// Money rules (the analyze POST has no idempotency key, so a second POST is a
// second paid job):
//  - one POST per request that no running job already covers: a job of the
//    same file covers a request when it analyzes every requested page (no
//    `pages`, a superset, or an AcroForm job, which ignores `pages`) and, for
//    save_as_template, saves. An in-process in-flight map shares the POST
//    between concurrent calls, and O_EXCL lock files share it between
//    processes. The job id is written into the lock as soon as it is known, so
//    a later call (or a later session) resumes polling instead of re-posting.
//  - the POST is detached from the tool call: a cancelled or timed-out call
//    never aborts it, and shutdown waits for it so its job id is recorded.
//    A 429 the server answers before creating a job (rate_limited,
//    too_many_active_jobs, queue_full) is waited out in-process and re-POSTed
//    (api.ts, ~60 s budget per call; cancelling the call ends the wait), so an
//    agent with no way to sleep needn't hammer analyze_form.
//  - a lock without a job id is honoured for 10 minutes (an upload in flight,
//    a crashed holder, or an upload whose outcome is unknown — timed from the
//    failure).
//  - only this API account's jobs and template ids are used: a cache written
//    against another FENFILL_API_URL or workspace never resumes or leaks.
//  - a pending job is dropped when its result can't exist any more (24 h), the
//    poll says it never will (410/404/frozen, or 3 failures in a row), or the
//    agent passes `force`.

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as sleepTimer } from "node:timers/promises";

import {
  hasInfoTag,
  MCP_OUTPUT_TAG,
  prefilledAcroFieldCount,
} from "@/app/t/[template_id]/fillCore";

import type { FenfillApi } from "./api.js";
import {
  accessOf,
  type AnalyzeOptions,
  type ApiIdentity,
  type Cache,
  type CachedAnalysis,
  extraBlanksPagesOf,
  type IdentityTagged,
  optionsHash,
  PENDING_MAX_AGE_MS,
  type PendingEntry,
  type PendingRead,
  pagesToSpec,
  sameAccount,
  sha256Hex,
  STALE_LOCK_MS,
} from "./cache.js";
import { compactView } from "./compact.js";
import { ToolError } from "./errors.js";
import { estimateAnalyze } from "./estimate.js";
import { isPasswordError, passwordError, readInputPdf } from "./fill.js";
import { toArrayBuffer } from "./fonts.js";
import { log } from "./log.js";
import {
  type CacheHit,
  cacheHit,
  coversExtraBlanks,
  type MergedForm,
  mergeAnalyses,
  soleTemplateId,
} from "./merge.js";
import { parsePageSpec } from "./pages.js";
import type { Account, JobBody } from "./types.js";

export interface JobRef {
  job_id: string;
  pages: number[];
  mode: "ai" | "acroform";
  cost: number;
  /** The pending entry recording this job, and the options it was started
   *  with (they may cover more than the request that resumed it). */
  optsHash: string;
  options: AnalyzeOptions;
  /** Consecutive failed polls recorded so far. */
  poll_errors: number;
  /** The 202's free AcroForm hint, kept until the result is cached. */
  extra_blanks_available?: boolean;
  /** The 202's extra-blank pages (an AcroForm job with detect_extra_blanks):
   *  the only pages its vision pass scans. Kept until the result is cached. */
  extra_blanks_pages?: number[];
}

export interface AnalyzeDeps {
  cache: Cache;
  /** Built on demand, so a cache hit needs no API key. */
  api: () => FenfillApi;
  /**
   * This server's API + account, or null without a usable key. `fetchWs`
   * looks the workspace id up (GET /v1/account, memoized per key); without it
   * only what is known locally is returned.
   */
  identity: (fetchWs: boolean) => Promise<ApiIdentity | null>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitSeconds: number;
  inFlight: Map<string, InFlight>;
  /** Every live analyze POST, for the shutdown drain. */
  posts: Set<Promise<unknown>>;
  /** This server instance's lock-owner id (see LIVE_OWNERS). */
  owner: string;
  /** A note for a view whose form has local edits (edit_template). */
  editsNote?: (sha: string, templateId: string | null) => Promise<Record<string, unknown>>;
}

/** An acquisition (lock + POST) in flight in this process, shared by every
 *  call its options cover. */
export interface InFlight {
  options: AnalyzeOptions;
  job: Promise<Shared | { retry: true }>;
}

/**
 * Server instances alive in THIS process. A lock's holder is alive when its pid
 * is (another process), or — for this pid — when its owner id is registered
 * here, so two instances in one process behave like two processes.
 */
export const LIVE_OWNERS = new Set<string>();

export interface AnalyzeArgs {
  path: string;
  pages?: string;
  save_as_template?: boolean;
  /** The saved template's access (save_as_template only). */
  access?: "public" | "restricted";
  force?: boolean;
  /** Only work out the cost, locally: nothing is uploaded. */
  estimate?: boolean;
  /** AcroForm PDFs: also look for blanks without a native field (paid per page). */
  detect_extra_blanks?: boolean;
}

export interface CallCtx {
  signal: AbortSignal;
  progress?: (progress: number, message?: string) => Promise<void>;
}

const LOCK_WAIT_POLL_MS = 1000;
/** Consecutive non-retryable poll failures before a pending job is dropped. */
export const MAX_POLL_ERRORS = 3;
/** A poll error that means the job's result will never come. */
const TERMINAL_POLL_CODES = new Set(["result_expired", "not_found", "template_frozen"]);
const NEXT_RUNNING = "call analyze_form again with the same path and options — no extra charge";
const NEXT_RUNNING_FORCED =
  "call analyze_form again with the same path and options but WITHOUT force — that resumes this analysis at no extra charge (with force it would start, and pay for, another one)";
/** On a result with no saved template: how to keep layout corrections. */
export const UNSAVED_NOTE =
  "To correct the layout and keep the corrections, analyze with save_as_template: true (edits on an unsaved analysis can be used for filling/preview but can't be saved).";
const unsavedNote = (templateId: string | null | undefined) =>
  templateId ? {} : { save_note: UNSAVED_NOTE };
const NEXT_NARROW =
  'This form is too large to list at once. Call analyze_form again with the same path and `pages` (e.g. "1-3") to see its fields; on an analyzed form that is free.';

/**
 * The pages a view reports: `analyzed_pages` is what this request listed
 * (requested ∩ analyzed); any other analyzed page of the file (an AcroForm job
 * reads every page at once, an earlier chunk) is `other_analyzed_pages`.
 */
export function pagesReport(
  covered: readonly number[],
  requested: readonly number[] | null,
): Record<string, string> {
  if (!requested) return { analyzed_pages: pagesToSpec([...covered]) };
  const want = new Set(requested);
  const shown = covered.filter((p) => want.has(p));
  const other = covered.filter((p) => !want.has(p));
  if (!other.length) return { analyzed_pages: pagesToSpec(shown) };
  return {
    analyzed_pages: pagesToSpec(shown),
    other_analyzed_pages: pagesToSpec(other),
    pages_note:
      "other_analyzed_pages are analyzed and cached too: list them free with analyze_form pages.",
  };
}

export async function localPageCount(pdf: ArrayBuffer): Promise<number | null> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    const n = doc.getPageCount();
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The pages a finished job analyzed: the job's own list, else the accept
 * response's, else (never seen in practice) every page the result lists. */
function coveredPages(body: JobBody, ref: JobRef): number[] {
  if (Array.isArray(body.pages) && body.pages.length) return body.pages;
  if (ref.pages.length) return ref.pages;
  return (body.result?.pages ?? []).map((p) => p.page).filter((p) => Number.isInteger(p));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is the process (or, in this process, the server instance) holding a lock alive? */
export function holderAlive(e: PendingEntry): boolean {
  return e.pid === process.pid
    ? typeof e.owner === "string" && LIVE_OWNERS.has(e.owner)
    : pidAlive(e.pid);
}

function lockedOut(ageMs: number): ToolError {
  const mins = Math.max(1, Math.ceil((STALE_LOCK_MS - ageMs) / 60_000));
  return new ToolError(
    "upload_outcome_unknown",
    "An earlier upload of this file was interrupted and it's unknown whether its analysis started.",
    {
      hint: `To avoid paying twice, analyze_form won't re-upload this file for about ${String(mins)} more minute(s). Check get_account (scans_remaining) and list_templates meanwhile.`,
    },
  );
}

type Running = {
  status: "running";
  job_id: string | null;
  progress: number;
  phase: string | null;
  next: string;
  extra_blanks_available?: boolean;
};

function running(
  forced: boolean,
  jobId: string | null,
  progress = 0,
  phase: string | null = null,
): Running {
  return {
    status: "running",
    job_id: jobId,
    progress,
    phase,
    next: forced ? NEXT_RUNNING_FORCED : NEXT_RUNNING,
  };
}

const TIMEOUT = Symbol("timeout");

/**
 * Wait for `p` until the deadline. A REAL timer on purpose (the budget is wall
 * time); losing the race never cancels `p` (an upload keeps going).
 */
async function raceDeadline<T>(
  p: Promise<T>,
  deadline: number,
  deps: AnalyzeDeps,
  signal: AbortSignal,
): Promise<T | typeof TIMEOUT> {
  const ms = Math.max(0, deadline - deps.now());
  const ac = new AbortController();
  const both = AbortSignal.any([signal, ac.signal]);
  try {
    return await Promise.race([
      p,
      sleepTimer(ms, undefined, { signal: both }).then(
        (): typeof TIMEOUT => TIMEOUT,
        (): typeof TIMEOUT => {
          if (signal.aborted) throw new ToolError("cancelled", "The call was cancelled.");
          return TIMEOUT;
        },
      ),
    ]);
  } finally {
    ac.abort();
  }
}

/** What a request needs from a job that would serve it. */
interface Want {
  options: AnalyzeOptions;
  requested: number[] | null;
  pageCount: number | null;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * Does a job (running or about to be posted) analyze everything a request
 * needs? No `pages` covers every page, an explicit list any subset of it, and
 * an AcroForm job ignores `pages`. A saving job covers a non-saving request,
 * never the reverse. For detect_extra_blanks, an AcroForm job's extra pass
 * covers only its extra_blanks_pages (its `pages` are every native-field page).
 */
export function jobCovers(
  job: {
    options?: AnalyzeOptions;
    pages?: number[];
    mode?: string;
    extra_blanks_pages?: number[];
  },
  want: Want,
): boolean {
  const o = job.options;
  if (!o || typeof o !== "object") return false;
  if (want.options.save_as_template && o.save_as_template !== true) return false;
  // A saved template keeps the access it was saved with.
  if (want.options.save_as_template && accessOf(o) !== accessOf(want.options)) return false;
  // Extra-blank detection: only a job that ran it (or an AI job: vision
  // already looks everywhere) covers it, and only on the pages it scanned.
  const extra = want.options.detect_extra_blanks === true;
  if (extra && o.detect_extra_blanks !== true && job.mode !== "ai") return false;
  if (o.pages === want.options.pages) return true;
  if (job.mode === "acroform" && !extra) return true;
  let have: number[] | null;
  const extraPages = extra ? extraBlanksPagesOf(job) : null;
  if (extraPages) have = extraPages;
  else if (extra && o.detect_extra_blanks === true) {
    // No list (an AI job, a job not accepted yet, or an older entry): what it
    // was asked to scan. An AcroForm job's `pages` would over-claim.
    have = null;
    if (o.pages !== null) {
      try {
        have = parsePageSpec(String(o.pages));
      } catch {
        return false;
      }
    }
  } else if (Array.isArray(job.pages) && job.pages.length) have = job.pages;
  else if (o.pages === null) have = null;
  else {
    try {
      have = parsePageSpec(String(o.pages));
    } catch {
      return false;
    }
  }
  if (have === null) return true;
  const need = want.requested ?? (want.pageCount ? range(want.pageCount) : null);
  if (!need) return false;
  const set = new Set(have);
  return need.every((p) => set.has(p));
}

function refOf(e: PendingEntry & { job_id: string }, optsHash: string): JobRef {
  return {
    job_id: e.job_id,
    pages: Array.isArray(e.pages) ? e.pages : [],
    mode: e.mode ?? "ai",
    cost: typeof e.cost === "number" ? e.cost : 0,
    optsHash,
    options: e.options,
    poll_errors: typeof e.poll_errors === "number" ? e.poll_errors : 0,
    ...(typeof e.extra_blanks_available === "boolean"
      ? { extra_blanks_available: e.extra_blanks_available }
      : {}),
    ...withExtraPages(e),
  };
}

/** `{extra_blanks_pages}` when `x` carries a valid list, else nothing. */
function withExtraPages(x: { extra_blanks_pages?: unknown }): { extra_blanks_pages?: number[] } {
  const pages = extraBlanksPagesOf(x);
  return pages ? { extra_blanks_pages: pages } : {};
}

/** Would `who` change if the workspace id were looked up? Only when an entry
 *  of the same API with a workspace id doesn't match by key alone. */
function needsWorkspace(entries: readonly IdentityTagged[], who: ApiIdentity | null): boolean {
  if (!who || who.account.workspace_id) return false;
  return entries.some(
    (e) => e.api_origin === who.api_origin && !!e.account?.workspace_id && !sameAccount(e, who),
  );
}

export async function analyzeForm(
  deps: AnalyzeDeps,
  args: AnalyzeArgs,
  ctx: CallCtx,
): Promise<Record<string, unknown>> {
  const deadline = deps.now() + deps.waitSeconds * 1000;
  const { abs, bytes } = await readInputPdf(args.path);
  const sha = sha256Hex(bytes);
  const ab = toArrayBuffer(bytes);

  // 1. Blank forms only.
  let tagged: boolean;
  try {
    tagged = await hasInfoTag(ab, MCP_OUTPUT_TAG);
  } catch {
    throw new ToolError("not_pdf", "The file could not be read as a PDF.", {
      hint: "Pass a valid PDF file.",
    });
  }
  if (tagged || (await deps.cache.isRegisteredOutput(sha))) {
    throw new ToolError(
      "filled_output",
      "This PDF is a form filled by fenfill-mcp, not a blank form.",
      {
        hint: "Analyze the original blank PDF instead.",
      },
    );
  }
  let prefilled: number;
  try {
    prefilled = await prefilledAcroFieldCount(ab);
  } catch (e) {
    if (isPasswordError(e)) throw passwordError();
    throw new ToolError(
      "unverifiable_form",
      "Couldn't verify that this PDF's form fields are blank.",
      {
        hint: "Open it in the fenfill web app instead (fenfill.com).",
      },
    );
  }
  if (prefilled > 0) {
    throw new ToolError(
      "prefilled_form",
      `This PDF has ${String(prefilled)} filled-in form field(s). fenfill analyzes blank forms only.`,
      {
        hint: "Use a blank copy of the form. Your answers go in fill_form, which runs locally. If this IS the blank form (some ship with default text or totals in their fields), use the fenfill web app for it instead.",
      },
    );
  }

  const pageCount = await localPageCount(ab);
  const requested = args.pages?.trim() ? parsePageSpec(args.pages, pageCount) : null;
  if (args.access && args.save_as_template !== true) {
    throw new ToolError("invalid_argument", "access applies to a saved template.", {
      hint: 'Pass save_as_template: true with access, e.g. access: "restricted" for recipient links.',
    });
  }
  const options: AnalyzeOptions = {
    pages: requested ? pagesToSpec(requested) : null,
    save_as_template: args.save_as_template === true,
    ...(args.save_as_template === true && args.access === "restricted"
      ? { access: "restricted" as const }
      : {}),
    ...(args.detect_extra_blanks === true ? { detect_extra_blanks: true as const } : {}),
  };
  const force = args.force === true;
  const want: Want = { options, requested, pageCount };

  // Whose template ids and jobs this call may use. Local first: a cache hit
  // needs no network unless another key of the same workspace wrote the entry.
  let who = await deps.identity(false);
  const fromCache = async (): Promise<CacheHit | null> => {
    const all = await deps.cache.listAnalyses(sha);
    if (needsWorkspace(all, who)) who = await deps.identity(true);
    return cacheHit(
      all,
      requested,
      options.save_as_template,
      pageCount,
      who,
      accessOf(options),
      options.detect_extra_blanks === true,
    );
  };
  const serve = async (hit: CacheHit) => {
    // The view shown is what fill_form fills: a one-analysis (template) view
    // becomes the newest analysis of its pages.
    if (hit.bump) {
      await deps.cache
        .saveAnalysis({ ...hit.bump, served_at: new Date(deps.now()).toISOString() })
        .catch(() => undefined);
    }
    await deps.cache.touchForm(sha);
    return {
      status: "done",
      cached: true,
      cost: 0,
      template_id: hit.template_id,
      ...unsavedNote(hit.template_id),
      ...pagesReport(hit.merged.covered, requested),
      ...extraBlanksReport(hit.merged, requested),
      ...(await deps.editsNote?.(sha, hit.template_id)),
      ...compactView(hit.merged.agent, requested, NEXT_NARROW),
    };
  };

  // Estimate only: count pages and probe native fields here, no upload. The
  // one request is GET /v1/account (scans_remaining), when a key is set.
  if (args.estimate === true) {
    const hit = force ? null : await fromCache();
    return {
      ...(await estimateAnalyze({
        pdf: ab,
        pageCount,
        requested,
        cached: !!hit,
        detectExtraBlanks: args.detect_extra_blanks === true,
        account: async (): Promise<Account | null> => {
          if (!(await deps.identity(false))) return null;
          const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]);
          return (await deps.api().getJson<Account>("/account", { signal })).body;
        },
      })),
    };
  }

  // 2. Cached: free — unless a forced re-analysis of these pages is running
  //    (its result replaces the cached one).
  if (!force) {
    const pend = await deps.cache.listPending(sha);
    if (
      needsWorkspace(
        pend.map((p) => p.entry ?? {}),
        who,
      )
    )
      who = await deps.identity(true);
    const reanalyzing = pend.some(
      (p) =>
        p.entry?.forced === true &&
        !!p.entry.job_id &&
        p.ageMs <= PENDING_MAX_AGE_MS &&
        sameAccount(p.entry, who) &&
        jobCovers(p.entry, want),
    );
    if (!reanalyzing) {
      const hit = await fromCache();
      if (hit) return serve(hit);
    }
  }

  // 3./4. Resume a job that covers this request, or lock + POST once.
  deps.api(); // a missing or malformed key fails here, before any lock
  who = await deps.identity(true);
  if (!who) throw new ToolError("missing_api_key", "FENFILL_API_KEY is not set.");
  const oh = optionsHash(options, who);
  const got = await acquireJob(deps, {
    sha,
    oh,
    want,
    who,
    bytes,
    filename: basename(abs),
    deadline,
    signal: ctx.signal,
    force,
    fromCache,
  });
  if ("cached" in got) return serve(got.cached);
  if ("running" in got) return got.running;

  // 5./6./7. Poll within the budget.
  const polled = await pollJob(deps, sha, got.ref, deadline, ctx, force);
  if ("running" in polled) return polled.running;
  const body = polled.done;
  const result = body.result;
  const render = body.render;
  if (!result || !render) throw new ToolError("internal_error", "The analysis came back empty.");
  const entry: CachedAnalysis = {
    v: 1,
    sha256: sha,
    options: got.ref.options,
    job_id: got.ref.job_id,
    template_id: body.template_id ?? null,
    mode: body.mode ?? got.ref.mode,
    cost: typeof body.cost === "number" ? body.cost : got.ref.cost,
    pages: coveredPages(body, got.ref),
    page_count: pageCount,
    render,
    agent: result,
    at: new Date(deps.now()).toISOString(),
    api_origin: who.api_origin,
    account: who.account,
    ...(typeof body.extra_blanks_available === "boolean"
      ? { extra_blanks_available: body.extra_blanks_available }
      : typeof got.ref.extra_blanks_available === "boolean"
        ? { extra_blanks_available: got.ref.extra_blanks_available }
        : {}),
    ...withExtraPages(got.ref),
  };
  await deps.cache.saveAnalysis(entry);
  await deps.cache.removePending(sha, got.ref.optsHash, { job_id: got.ref.job_id });
  log("info", "analysis cached", { job: entry.job_id, mode: entry.mode, cost: entry.cost });

  // The view covers the whole merged form (chunks included), narrowed to the
  // request; a template request sees the template alone.
  const merged = options.save_as_template
    ? mergeAnalyses([entry])
    : mergeAnalyses(await deps.cache.listAnalyses(sha));
  if (!merged) throw new ToolError("internal_error", "The analysis could not be cached.");
  const templateId = entry.template_id ?? soleTemplateId(merged, requested, who);
  return {
    status: "done",
    cached: false,
    job_id: entry.job_id,
    mode: entry.mode,
    cost: entry.cost,
    template_id: templateId,
    ...unsavedNote(templateId),
    ...pagesReport(merged.covered, requested),
    ...extraBlanksReport(merged, requested),
    ...(await deps.editsNote?.(sha, templateId)),
    ...compactView(merged.agent, requested, NEXT_NARROW),
  };
}

/**
 * The AcroForm extra-blank hint for a view: `extra_blanks_available` is true
 * when a shown page came from a plain AcroForm analysis whose server-side
 * heuristic saw blanks without a native field, false when every such analysis
 * said no, and absent otherwise (AI, or an older cache entry).
 */
export function extraBlanksReport(
  merged: MergedForm,
  requested: readonly number[] | null,
): Record<string, unknown> {
  const pages = requested ?? merged.covered;
  const srcs = new Set(
    pages.map((p) => merged.sources.get(p)).filter((e) => e && !coversExtraBlanks(e)),
  );
  const flags = [...srcs].map((e) => e?.extra_blanks_available);
  if (flags.includes(true)) {
    return {
      extra_blanks_available: true,
      extra_blanks_note:
        "This PDF's native form fields may miss some blanks (e.g. a signature or date line). analyze_form with detect_extra_blanks: true finds them, at 1 page scan per analyzed page (pass pages to limit it).",
    };
  }
  if (flags.length && flags.every((f) => f === false)) return { extra_blanks_available: false };
  return {};
}

interface AcquireArgs {
  sha: string;
  oh: string;
  want: Want;
  who: ApiIdentity;
  bytes: Uint8Array;
  filename: string;
  deadline: number;
  signal: AbortSignal;
  force: boolean;
  fromCache: () => Promise<CacheHit | null>;
}

/** What an acquisition yields to every call sharing it. */
export type Shared = { ref: JobRef } | { cached: CacheHit };

type Acquired = Shared | { running: Running };

/** This process's acquisition in flight that covers the request (ours first). */
function sharedInFlight(deps: AnalyzeDeps, a: AcquireArgs): InFlight | undefined {
  const own = deps.inFlight.get(`${a.sha}.${a.oh}`);
  if (own) return own;
  for (const [key, f] of deps.inFlight) {
    if (key.startsWith(`${a.sha}.`) && jobCovers({ options: f.options }, a.want)) return f;
  }
  return undefined;
}

/** What one pending entry means for this request. */
type Verdict =
  | { kind: "ignore" }
  | { kind: "resume"; ref: JobRef }
  | { kind: "drop"; match: PendingRead["stamp"] }
  | { kind: "wait" }
  | { kind: "locked"; sinceMs: number };

function judge(p: PendingRead, a: AcquireArgs, now: number): Verdict {
  const v = judgeEntry(p, a, now);
  // Whatever sits on OUR lock path blocks the claim: never ignore it (that
  // would spin on EEXIST). Anything we can't use there is waited out, then
  // taken over once stale.
  if (v.kind === "ignore" && p.optsHash === a.oh) {
    return p.ageMs > STALE_LOCK_MS ? { kind: "drop", match: p.stamp } : { kind: "wait" };
  }
  return v;
}

function judgeEntry(p: PendingRead, a: AcquireArgs, now: number): Verdict {
  const exact = p.optsHash === a.oh;
  const e = p.entry;
  // Unreadable, or caught between the O_EXCL create and its first write: only
  // our own lock path matters (see judge).
  if (!e) return { kind: "ignore" };
  // Another API or account's job: never resumed (it would 404 or leak).
  if (!sameAccount(e, a.who) || !jobCovers(e, a.want)) return { kind: "ignore" };
  if (typeof e.job_id === "string" && e.job_id) {
    // Past 24 h the result is gone; `force` drops our own job id (never
    // someone's lockout) so the POST can go ahead.
    if (p.ageMs > PENDING_MAX_AGE_MS || (a.force && exact)) {
      return { kind: "drop", match: p.stamp };
    }
    if (a.force) return { kind: "ignore" };
    return { kind: "resume", ref: refOf({ ...e, job_id: e.job_id }, p.optsHash) };
  }
  // No job id: an upload in flight, or one whose outcome is unknown.
  const failed = e.unknown_outcome ? Date.parse(e.failed_at ?? e.created_at) : NaN;
  const sinceMs = Number.isFinite(failed) ? now - failed : p.ageMs;
  if (sinceMs > STALE_LOCK_MS) return exact ? { kind: "drop", match: p.stamp } : { kind: "ignore" };
  if (e.unknown_outcome || !holderAlive(e)) return { kind: "locked", sinceMs };
  return { kind: "wait" };
}

async function acquireJob(deps: AnalyzeDeps, a: AcquireArgs): Promise<Acquired> {
  const key = `${a.sha}.${a.oh}`;
  for (;;) {
    if (a.signal.aborted) throw new ToolError("cancelled", "The call was cancelled.");

    // Same process: share an acquisition (and its one POST) already in flight.
    const shared = sharedInFlight(deps, a);
    if (shared) {
      const r = await raceDeadline(shared.job, a.deadline, deps, a.signal);
      if (r === TIMEOUT) return { running: running(a.force, null) };
      if ("retry" in r) continue;
      if ("cached" in r) {
        // Found for the claimant's request: look again for ours (`force`
        // never takes a cached answer: it claims its own POST next).
        if (a.force) continue;
        const hit = await a.fromCache();
        if (hit) return { cached: hit };
        continue;
      }
      return r;
    }

    const pends = await deps.cache.listPending(a.sha);
    if (sharedInFlight(deps, a)) continue; // claimed in this process meanwhile

    // Other processes (or earlier sessions): resume a job that covers this
    // request; wait on a live upload that will; stay locked out after an
    // upload whose outcome is unknown.
    pends.sort((x, y) => Number(y.optsHash === a.oh) - Number(x.optsHash === a.oh));
    let wait = false;
    let lockedSince: number | null = null;
    let changed = false;
    for (const p of pends) {
      const v = judge(p, a, deps.now());
      if (v.kind === "resume") {
        log("info", "resuming analysis", { job: v.ref.job_id });
        return { ref: v.ref };
      }
      if (v.kind === "drop") {
        await deps.cache.removePending(a.sha, p.optsHash, { stamp: v.match });
        changed = true;
        break;
      }
      if (v.kind === "wait") wait = true;
      if (v.kind === "locked") lockedSince = Math.min(lockedSince ?? v.sinceMs, v.sinceMs);
    }
    if (changed) continue;
    if (lockedSince !== null) throw lockedOut(lockedSince);
    if (wait) {
      if (deps.now() + LOCK_WAIT_POLL_MS > a.deadline) return { running: running(a.force, null) };
      try {
        await deps.sleep(LOCK_WAIT_POLL_MS, a.signal);
      } catch {
        throw new ToolError("cancelled", "The call was cancelled.");
      }
      continue;
    }

    // Claim the acquisition for this process SYNCHRONOUSLY (no await between the
    // in-flight check above and the set below), then take the O_EXCL lock.
    const api = deps.api();
    const token = randomBytes(8).toString("hex");
    const lock: PendingEntry = {
      v: 1,
      sha256: a.sha,
      options: a.want.options,
      created_at: new Date(deps.now()).toISOString(),
      pid: process.pid,
      owner: deps.owner,
      token,
      api_origin: a.who.api_origin,
      account: a.who.account,
      ...(a.force ? { forced: true } : {}),
    };
    const job = (async (): Promise<Shared | { retry: true }> => {
      if (!(await deps.cache.tryCreatePending(lock, a.oh))) return { retry: true };
      // Someone may have finished this analysis between our cache check and the lock.
      if (!a.force) {
        const hit = await a.fromCache();
        if (hit) {
          await deps.cache.removePending(a.sha, a.oh, { token });
          return { cached: hit };
        }
      }
      let accepted;
      try {
        accepted = await api.analyze(
          a.bytes,
          a.filename,
          {
            pages: a.want.options.pages ?? undefined,
            saveAsTemplate: a.want.options.save_as_template,
            access: a.want.options.access,
            detectExtraBlanks: a.want.options.detect_extra_blanks === true,
          },
          {
            // A 429 refused before any job existed is waited out here (bounded);
            // the claimant's cancellation ends the wait, never a POST in flight.
            signal: a.signal,
            onWait: (seconds, code) => {
              log("info", "analyze refused, waiting to retry", { code, seconds });
            },
          },
        );
      } catch (err) {
        if (err instanceof ToolError && err.code === "upload_outcome_unknown") {
          const failedAt = new Date(deps.now()).toISOString();
          await deps.cache
            .updatePending({ ...lock, unknown_outcome: true, failed_at: failedAt }, a.oh)
            .catch(() => undefined);
        } else {
          await deps.cache.removePending(a.sha, a.oh, { token }).catch(() => false);
        }
        log("warn", "analyze upload failed", {
          code: err instanceof ToolError ? err.code : "error",
        });
        throw err;
      }
      const ref: JobRef = {
        job_id: accepted.job_id,
        pages: Array.isArray(accepted.pages) ? accepted.pages : [],
        mode: accepted.mode,
        cost: accepted.cost,
        optsHash: a.oh,
        options: a.want.options,
        poll_errors: 0,
        ...(typeof accepted.extra_blanks_available === "boolean"
          ? { extra_blanks_available: accepted.extra_blanks_available }
          : {}),
        ...withExtraPages(accepted),
      };
      await deps.cache.updatePending(
        {
          ...lock,
          job_id: ref.job_id,
          pages: ref.pages,
          mode: ref.mode,
          cost: ref.cost,
          ...(ref.extra_blanks_available !== undefined
            ? { extra_blanks_available: ref.extra_blanks_available }
            : {}),
          ...withExtraPages(ref),
        },
        a.oh,
      );
      log("info", "analysis queued", { job: ref.job_id, mode: ref.mode, cost: ref.cost });
      return { ref };
    })();
    deps.inFlight.set(key, { options: a.want.options, job });
    deps.posts.add(job);
    const settle = () => {
      deps.inFlight.delete(key);
      deps.posts.delete(job);
    };
    job.then(settle, settle);
    // Loop: the next pass shares `job` like any other in-process caller.
  }
}

/** A poll failure that says nothing about the job itself: retry it forever. */
function transientPollError(e: ToolError): boolean {
  if (e.code === "bad_response") return false; // a 2xx we can't read
  if (e.status === undefined) return true; // network, timeout, cancelled
  return e.status === 401 || e.status === 429 || e.status === 503 || e.code === "rate_limited";
}

async function recordPollError(deps: AnalyzeDeps, sha: string, ref: JobRef): Promise<number> {
  const p = await deps.cache.readPending(sha, ref.optsHash).catch(() => null);
  const e = p?.entry;
  if (!e || e.job_id !== ref.job_id) return ref.poll_errors + 1;
  const n = (typeof e.poll_errors === "number" ? e.poll_errors : 0) + 1;
  await deps.cache.updatePending({ ...e, poll_errors: n }, ref.optsHash).catch(() => undefined);
  return n;
}

async function resetPollErrors(deps: AnalyzeDeps, sha: string, ref: JobRef): Promise<void> {
  const p = await deps.cache.readPending(sha, ref.optsHash).catch(() => null);
  const e = p?.entry;
  if (!e || e.job_id !== ref.job_id || !e.poll_errors) return;
  await deps.cache.updatePending({ ...e, poll_errors: 0 }, ref.optsHash).catch(() => undefined);
}

async function pollJob(
  deps: AnalyzeDeps,
  sha: string,
  ref: JobRef,
  deadline: number,
  ctx: CallCtx,
  forced: boolean,
): Promise<{ done: JobBody } | { running: Running }> {
  const api = deps.api();
  const clearPending = () =>
    deps.cache.removePending(sha, ref.optsHash, { job_id: ref.job_id }).catch(() => false);
  // Count a failure against the job; after MAX_POLL_ERRORS in a row, drop it.
  const failed = async (err: ToolError): Promise<never> => {
    const n = await recordPollError(deps, sha, ref);
    if (n < MAX_POLL_ERRORS) throw err;
    await clearPending();
    log("warn", "analysis dropped", { job: ref.job_id, code: err.code });
    throw new ToolError(err.code, err.message, {
      hint: `fenfill failed on this analysis ${String(n)} times in a row, so it was dropped. Call analyze_form again to start a new one (this costs page scans again).`,
      status: err.status,
      details: { ...err.details, job_id: ref.job_id },
    });
  };
  let cleanStreak = ref.poll_errors === 0;
  let last = -1;
  for (;;) {
    let got;
    try {
      got = await api.getJson<JobBody>(`/jobs/${encodeURIComponent(ref.job_id)}?include=render`, {
        signal: ctx.signal,
        deadline,
      });
    } catch (e) {
      if (e instanceof ToolError && !transientPollError(e)) {
        // Terminal for this job id: forget it, so the next call starts afresh.
        if (TERMINAL_POLL_CODES.has(e.code)) {
          await clearPending();
          throw e;
        }
        await failed(e);
      }
      throw e;
    }
    const body = got.body;
    if (body.status === "done") {
      if (body.result && body.render) return { done: body };
      await failed(
        new ToolError("bad_response", "fenfill returned a finished job without its schema.", {
          hint: "Call analyze_form again with the same path; it resumes this job.",
        }),
      );
    }
    if (!cleanStreak) {
      cleanStreak = true;
      await resetPollErrors(deps, sha, ref);
    }
    if (body.status === "error") {
      const err = body.error ?? { code: "internal_error", message: "The analysis failed." };
      await clearPending();
      log("warn", "analysis failed", { job: ref.job_id, code: err.code });
      throw new ToolError(err.code, err.message, {
        hint: jobErrorHint(err.code),
        details: { job_id: ref.job_id },
      });
    }
    const progress = typeof body.progress === "number" ? body.progress : 0;
    if (ctx.progress && progress > last) {
      last = progress;
      await ctx.progress(progress, body.phase ?? body.status).catch(() => undefined);
    }
    const ra = Number(got.headers.get("retry-after"));
    const waitS = Number.isFinite(ra) && ra > 0 ? ra : body.status === "queued" ? 10 : 3;
    if (deps.now() + waitS * 1000 > deadline) {
      const r = running(forced, ref.job_id, progress, body.phase ?? body.status);
      if (ref.extra_blanks_available !== undefined) {
        r.extra_blanks_available = ref.extra_blanks_available;
      }
      return { running: r };
    }
    try {
      await deps.sleep(waitS * 1000, ctx.signal);
    } catch {
      throw new ToolError("cancelled", "The call was cancelled.", {
        hint: "The analysis keeps running: call analyze_form again with the same path to resume it at no extra charge.",
      });
    }
  }
}

function jobErrorHint(code: string): string {
  switch (code) {
    case "no_fields_found":
      return "fenfill found no fillable fields on the analyzed pages. Any reserved scans are refunded.";
    case "template_limit":
      return "Analyze again without save_as_template, or delete a template in fenfill.";
    default:
      return "Any reserved scans are refunded automatically. Call analyze_form again to retry (it re-uploads).";
  }
}
