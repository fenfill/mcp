// The /v1 client. Bearer auth only, a fixed User-Agent, and the error envelope
// mapped to ToolErrors that carry the API code plus an actionable hint.
//
// Retry policy (privacy aside, the money rule): idempotent GETs are retried
// on `rate_limited` (429) or 503 while the server's Retry-After still fits the
// caller's budget. POSTs are sent once, with ONE exception: the analyze POST is
// re-sent after an enveloped 429 rate_limited / too_many_active_jobs /
// queue_full, because the server refuses those before it creates a job
// (v1_ingest.py: the per-key rate limit and upload slots come before the body
// is read, check_gates before insert_job), so nothing was created or charged.
// Those waits honour Retry-After, are jittered, bounded by ANALYZE_429_BUDGET_MS
// per call and cancellable; the POST itself is never tied to a cancellation
// signal (it has no idempotency key: a request cut mid-flight may still have
// created, and charged, a job). The template re-analyze POST (reanalyze_template)
// shares that wait-and-retry, with the same never-abortable POST.
//
// PRIVACY: nothing here ever sees fill values. Requests carry only ids, paging
// parameters, the blank PDF (analyze), a re-analysis's pages/kind/version, a
// recipient label and, from
// save_template, a template's layout and wording (its field schema).

import { setTimeout as sleepTimer } from "node:timers/promises";

import type { ApiConfig } from "./config.js";
import { ToolError } from "./errors.js";
import type { AnalyzeAccepted, RerunEstimate } from "./types.js";
import { USER_AGENT } from "./version.js";

export interface ApiDeps {
  /** Resolved per call, so a stubbed globalThis.fetch is honoured. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** 0 ≤ x < 1, for retry jitter (Math.random by default). */
  random?: () => number;
}

/** How the analyze POST waits out a refusal-before-insert 429. */
export interface AnalyzeRetryOptions {
  /** Cancels a wait between attempts (never a POST in flight). */
  signal?: AbortSignal;
  /** Called before each wait, with its length in seconds. */
  onWait?: (seconds: number, code: string) => void;
}

/** 429s the server answers before it creates a job: safe to re-POST. */
export const ANALYZE_RETRY_CODES = new Set(["rate_limited", "too_many_active_jobs", "queue_full"]);
/** Total Retry-After the analyze POST waits out per call. */
export const ANALYZE_429_BUDGET_MS = 60_000;
/** A single Retry-After longer than this is not waited out. */
export const ANALYZE_429_MAX_SLEEP_MS = 30_000;
/** Up to this much random extra per wait, so parallel agents don't re-POST in lockstep. */
export const ANALYZE_429_JITTER_MS = 2_000;

export interface GetOptions {
  signal?: AbortSignal;
  /** Epoch ms. A retry happens only if its Retry-After wait ends before this. */
  deadline?: number;
}

const DEFAULT_GET_BUDGET_MS = 30_000;
const GET_TIMEOUT_MS = 120_000;
const MAX_GET_RETRIES = 4;
const DEFAULT_503_RETRY_S = 2;

// fetch() failures that prove nothing reached the server (so an analyze POST
// that failed this way created no job).
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const HINTS: Record<string, string> = {
  invalid_api_key:
    "Check FENFILL_API_KEY: copy the key again from fenfill (Settings → API keys). It starts with ff_live_.",
  key_revoked:
    "This API key was revoked. Create a new one in fenfill (Settings → API keys) and update FENFILL_API_KEY.",
  plan_required: "Your fenfill plan doesn't include this. Upgrade in fenfill (Settings → Billing).",
  template_frozen:
    "This template is frozen (over your plan's template limit). Unfreeze it in fenfill, or upgrade.",
  not_found: "Check the id.",
  invalid_request: "Check the arguments against the message.",
  template_limit:
    "The workspace is at its plan's template limit: analyze without save_as_template, or delete a template in fenfill.",
  template_not_restricted:
    "Recipient links need a restricted template: set the template's access to Restricted in fenfill, then retry.",
  result_expired:
    "The analysis result is gone: an unsaved result expires (24 h after the job, 1 h after it is first fetched), and a saved one goes with its template if that template was deleted. Call analyze_form again (it re-uploads and costs scans again); pass save_as_template=true to keep a result.",
  not_pdf: "Pass a PDF file.",
  pdf_password_required:
    "The PDF needs a password to open. Save a copy without the open password, then analyze that.",
  pdf_fill_forbidden: "The PDF's author forbids filling it in, so fenfill can't process it.",
  too_many_pages:
    "Analyze the document in chunks with `pages` (the message says how). fill_form merges the chunks into one form.",
  rate_limited: "Too many requests for this key. Wait the retry_after seconds, then retry.",
  daily_limit: "The workspace hit its daily AI limit. Try again after retry_after seconds.",
  too_many_active_jobs:
    "Other analyses in this workspace are still running (free native-field ones count too). Try again in a minute, or analyze fewer documents at once.",
  queue_full: "fenfill's analysis queue is full. Retry after retry_after seconds.",
  internal_error: "Something went wrong at fenfill. Retry shortly.",
  unavailable: "fenfill is temporarily unavailable. Retry shortly.",
  file_too_large: "The file is bigger than your plan allows. Use a smaller PDF, or upgrade.",
  template_conflict:
    "The template changed in fenfill since your edits started (current_updated_at). Your local edits are kept: discard them with edit_template {discard: true} and re-apply your ops on the current version, then save again.",
  invalid_schema:
    "fenfill rejected the edited layout (details lists each problem). Fix those items with edit_template, then save again.",
  request_too_large: "The edited template is too large to save in one request.",
  template_needs_migration:
    "This template has stored data the API can't save back as is (details says where). Ask the user to make this correction in the fenfill web editor instead.",
  job_in_progress:
    "A job is already running on this template (a re-analysis from this or another session, or the web app). Wait a minute or two, then check get_template (updated_at, pages[].analyzed) before retrying: a finished re-analysis may already show the new fields.",
  kind_required:
    'Some of these pages already have fields, so choose a kind: "find" adds blanks the first pass missed (keeps everything), "relabel" re-derives labels/types/groups keeping the boxes, "label_missing" fills in only missing labels, "scratch" replaces the pages\' fields entirely.',
};

/** What a request was about, for hints that depend on it (a 404 on a job poll
 *  is not a missing template). */
export type ErrorContext = "job" | "template" | "reanalyze" | "other";

/** The context of a /v1 path. */
export function contextOf(path: string): ErrorContext {
  if (path.startsWith("/jobs/")) return "job";
  if (/^\/templates\/[^/?]+\/analyze$/.test(path)) return "reanalyze";
  if (path.startsWith("/templates")) return "template";
  return "other";
}

// too_many_pages past the plan's page window ("Your plan analyzes the first N
// pages of a document; page P is past that."): chunking can't reach it.
const PAST_PLAN_WINDOW = /first \d+ pages? of a document|past that/i;

function hintFor(
  code: string,
  body: Record<string, unknown>,
  context: ErrorContext,
): string | undefined {
  if (context === "reanalyze") {
    if (code === "template_conflict") {
      return "The template changed in fenfill while this call was starting (current_updated_at). Re-fetch it with get_template, then call reanalyze_template again (it reads the current version itself).";
    }
    if (code === "too_many_pages") {
      return "Re-analyze fewer pages per call (the message says the limit), or pages within your plan's page window.";
    }
    if (code === "insufficient_scans") {
      const need = typeof body.need === "number" ? body.need : "?";
      const have = typeof body.have === "number" ? body.have : "?";
      return `This re-analysis needs ${String(need)} page scans and ${String(have)} are left. Re-analyze fewer pages, or add scans in fenfill (Settings → Billing). estimate: true prices it first.`;
    }
  }
  if (code === "template_frozen" && context === "job") {
    return "The analysis was saved as a template that is frozen (the workspace is over its plan's template limit). Unfreeze it in fenfill (or upgrade), then find it with list_templates and use get_template / fill_template.";
  }
  if (code === "insufficient_scans") {
    const need = typeof body.need === "number" ? body.need : "?";
    const have = typeof body.have === "number" ? body.have : "?";
    return `This analysis needs ${String(need)} page scans and ${String(have)} are left. Analyze fewer pages with \`pages\`, or add scans in fenfill (Settings → Billing).`;
  }
  if (code === "too_many_pages" && typeof body.message === "string") {
    if (PAST_PLAN_WINDOW.test(body.message)) {
      return "Your plan only analyzes a document's first pages (the message says how many), so splitting into chunks won't reach these: analyze pages within that range, or upgrade in fenfill (Settings → Billing).";
    }
  }
  if (code === "not_found") {
    if (context === "job") {
      return "fenfill has no record of this analysis job any more. Call analyze_form again: it starts a new analysis (this costs page scans again).";
    }
    if (context === "template" || context === "reanalyze") {
      return "Check the id. list_templates shows the workspace's template ids.";
    }
  }
  return HINTS[code];
}

function numHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Map an HTTP error response to a ToolError (never throws while parsing). */
export async function errorFromResponse(
  res: Response,
  context: ErrorContext = "other",
): Promise<ToolError> {
  let body: Record<string, unknown> = {};
  let enveloped = false;
  try {
    const parsed: unknown = await res.json();
    const err =
      parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
    if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
      body = err as Record<string, unknown>;
      enveloped = true;
    }
  } catch {
    // not JSON: fall through to the status-only mapping
  }
  const code = enveloped
    ? (body.code as string)
    : res.status === 503
      ? "unavailable"
      : res.status >= 500
        ? "internal_error"
        : `http_${String(res.status)}`;
  const message =
    typeof body.message === "string" && body.message
      ? body.message
      : `fenfill answered HTTP ${String(res.status)}.`;
  const retryAfter =
    typeof body.retry_after === "number" ? body.retry_after : numHeader(res.headers, "retry-after");
  const details: Record<string, unknown> = { status: res.status };
  if (retryAfter !== undefined) details.retry_after = retryAfter;
  for (const k of ["need", "have", "max_bytes", "current_updated_at"]) {
    if (k in body) details[k] = body[k];
  }
  if (Array.isArray(body.details)) details.details = body.details.slice(0, 50);
  if (!enveloped) details.enveloped = false;
  return new ToolError(code, message, {
    hint: hintFor(code, body, context),
    status: res.status,
    details,
  });
}

function isRetryable(err: ToolError): boolean {
  return err.code === "rate_limited" || err.status === 503;
}

function causeCode(e: unknown): string | undefined {
  const cause = e && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function networkError(e: unknown, origin: string): ToolError {
  if (e instanceof Error && e.name === "AbortError") {
    return new ToolError("cancelled", "The request was cancelled.");
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return new ToolError("timeout", "fenfill took too long to answer.", {
      hint: "Retry shortly.",
    });
  }
  return new ToolError("network_error", `Couldn't reach fenfill at ${origin}.`, {
    hint: "Check the internet connection (and FENFILL_API_URL if you set it), then retry.",
    details: causeCode(e) ? { cause: causeCode(e) } : {},
  });
}

export class FenfillApi {
  private readonly cfg: ApiConfig;
  private readonly deps: ApiDeps;

  constructor(cfg: ApiConfig, deps: ApiDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
  }

  get origin(): string {
    return new URL(this.cfg.apiUrl).origin;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms, signal);
    await sleepTimer(ms, undefined, { signal });
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.deps.fetchImpl ?? globalThis.fetch;
    return f(url, init);
  }

  private url(path: string): string {
    return `${this.cfg.apiUrl}/v1${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  /** A GET with the retry policy; resolves only on a 2xx. */
  private async get(path: string, accept: string, opts: GetOptions = {}): Promise<Response> {
    const deadline = opts.deadline ?? this.now() + DEFAULT_GET_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(GET_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.doFetch(this.url(path), {
          method: "GET",
          headers: this.headers({ Accept: accept }),
          signal,
          redirect: "error",
        });
      } catch (e) {
        throw networkError(e, this.origin);
      }
      if (res.ok) return res;
      const err = await errorFromResponse(res, contextOf(path));
      if (!isRetryable(err) || attempt >= MAX_GET_RETRIES) throw err;
      const ra = err.details.retry_after;
      const waitS = typeof ra === "number" ? ra : DEFAULT_503_RETRY_S;
      if (this.now() + waitS * 1000 > deadline) throw err;
      try {
        await this.sleep(waitS * 1000, opts.signal);
      } catch (e) {
        throw networkError(e, this.origin);
      }
    }
  }

  async getJson<T>(path: string, opts: GetOptions = {}): Promise<{ body: T; headers: Headers }> {
    const res = await this.get(path, "application/json", opts);
    try {
      return { body: (await res.json()) as T, headers: res.headers };
    } catch {
      throw new ToolError("bad_response", "fenfill sent an unreadable response.", {
        hint: "Retry shortly.",
      });
    }
  }

  /** Binary GET. `null` on a 404 when `allow404` (e.g. no branding logo). */
  async getBytes(
    path: string,
    opts: GetOptions & { allow404?: boolean } = {},
  ): Promise<Uint8Array | null> {
    let res: Response;
    try {
      res = await this.get(path, "*/*", opts);
    } catch (e) {
      if (opts.allow404 && e instanceof ToolError && e.status === 404) return null;
      throw e;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A JSON POST, sent exactly once (never retried). */
  async postJson<T>(path: string, body: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(this.url(path), {
        method: "POST",
        headers: this.headers({ Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        signal: opts.signal,
        redirect: "error",
      });
    } catch (e) {
      throw networkError(e, this.origin);
    }
    if (!res.ok) throw await errorFromResponse(res, contextOf(path));
    return (await res.json()) as T;
  }

  /** A JSON PATCH, sent exactly once (never retried). */
  async patchJson<T>(path: string, body: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(this.url(path), {
        method: "PATCH",
        headers: this.headers({ Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        signal: opts.signal,
        redirect: "error",
      });
    } catch (e) {
      throw networkError(e, this.origin);
    }
    if (!res.ok) throw await errorFromResponse(res, contextOf(path));
    try {
      return (await res.json()) as T;
    } catch {
      throw new ToolError("bad_response", "fenfill sent an unreadable response.", {
        hint: "Call get_template to see whether the save went through.",
      });
    }
  }

  /**
   * POST /v1/forms/analyze. Each POST is deliberately NOT abortable: the
   * server has no idempotency key, so a request cut mid-flight may still have
   * created (and charged) a job. A failure whose outcome is unknown throws
   * `upload_outcome_unknown` so the caller keeps its lock instead of re-posting.
   * The only re-POST: after an enveloped 429 in ANALYZE_RETRY_CODES (refused
   * before any job exists), waiting its Retry-After plus jitter, within
   * ANALYZE_429_BUDGET_MS; `retry.signal` cancels a wait.
   */
  async analyze(
    pdf: Uint8Array,
    filename: string,
    form: {
      pages?: string;
      saveAsTemplate: boolean;
      access?: "restricted";
      detectExtraBlanks?: boolean;
    },
    retry: AnalyzeRetryOptions = {},
  ): Promise<AnalyzeAccepted> {
    return this.with429Retry(() => this.analyzeOnce(pdf, filename, form), retry);
  }

  /**
   * POST /v1/templates/{id}/analyze: re-analyze pages of a saved template from
   * the PDF already stored with it (no upload). JSON body {pages, kind?,
   * expected_updated_at} (or {pages, kind?, estimate: true}, which starts
   * nothing and answers 200 RerunEstimate). Same money rules as `analyze`: the
   * POST is never abortable, and only an enveloped 429 refused before any job
   * exists is waited out and re-sent. A failure whose outcome is unknown throws
   * `outcome_unknown` (fenfill refuses a duplicate run: one job per template,
   * and expected_updated_at).
   */
  async analyzeTemplate(
    templateId: string,
    body: { pages: string; kind?: string; expected_updated_at?: string; estimate?: true },
    retry: AnalyzeRetryOptions = {},
  ): Promise<AnalyzeAccepted | RerunEstimate> {
    return this.with429Retry(() => this.analyzeTemplateOnce(templateId, body), retry);
  }

  /**
   * Send `once` until it isn't a retryable refusal: an enveloped 429 in
   * ANALYZE_RETRY_CODES (refused before any job exists) is waited out with its
   * Retry-After plus jitter, within ANALYZE_429_BUDGET_MS; `retry.signal`
   * cancels a wait (never a POST in flight).
   */
  private async with429Retry<T>(
    once: () => Promise<T | { refused: ToolError }>,
    retry: AnalyzeRetryOptions,
  ): Promise<T> {
    let waitedMs = 0; // actual, jitter included (reported)
    let spentMs = 0; // Retry-After total (the budget; jitter rides on top)
    for (;;) {
      const r = await once();
      if (!(r && typeof r === "object" && "refused" in r)) return r;
      const err = (r as { refused: ToolError }).refused;
      const ra = err.details.retry_after;
      const retryable =
        ANALYZE_RETRY_CODES.has(err.code) &&
        err.status === 429 &&
        err.details.enveloped !== false &&
        typeof ra === "number";
      const waitMs = retryable ? Math.max(1, ra) * 1000 : Infinity;
      if (
        !retryable ||
        waitMs > ANALYZE_429_MAX_SLEEP_MS ||
        spentMs + waitMs > ANALYZE_429_BUDGET_MS ||
        retry.signal?.aborted
      ) {
        throw waitedMs > 0 ? afterWaiting(err, waitedMs) : err;
      }
      const rnd = this.deps.random ? this.deps.random() : Math.random();
      const sleepMs = Math.round(waitMs + rnd * ANALYZE_429_JITTER_MS);
      retry.onWait?.(sleepMs / 1000, err.code);
      try {
        await this.sleep(sleepMs, retry.signal);
      } catch {
        // Cancelled while waiting: nothing was created; report the refusal.
        throw afterWaiting(err, waitedMs);
      }
      waitedMs += sleepMs;
      spentMs += waitMs;
    }
  }

  /** One template-analyze POST: 202 / 200 (estimate), or a refusal that created no job. */
  private async analyzeTemplateOnce(
    templateId: string,
    body: { pages: string; kind?: string; expected_updated_at?: string; estimate?: true },
  ): Promise<AnalyzeAccepted | RerunEstimate | { refused: ToolError }> {
    const path = `/templates/${encodeURIComponent(templateId)}/analyze`;
    let res: Response;
    try {
      res = await this.doFetch(this.url(path), {
        method: "POST",
        headers: this.headers({ Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch (e) {
      const code = causeCode(e);
      if (body.estimate || (code && NOT_SENT_CODES.has(code))) throw networkError(e, this.origin);
      throw templateOutcomeUnknown();
    }
    if (res.status === 202 || (res.status === 200 && body.estimate)) {
      try {
        return (await res.json()) as AnalyzeAccepted | RerunEstimate;
      } catch {
        if (body.estimate) {
          throw new ToolError("bad_response", "fenfill sent an unreadable response.", {
            hint: "Retry shortly.",
          });
        }
        throw templateOutcomeUnknown();
      }
    }
    const err = await errorFromResponse(res, "reanalyze");
    if (!body.estimate && err.details.enveloped === false && res.status >= 500) {
      throw templateOutcomeUnknown();
    }
    if (res.status === 429) return { refused: err };
    throw err;
  }

  /** One analyze POST: the 202 body, or a refusal that created no job. */
  private async analyzeOnce(
    pdf: Uint8Array,
    filename: string,
    form: {
      pages?: string;
      saveAsTemplate: boolean;
      access?: "restricted";
      detectExtraBlanks?: boolean;
    },
  ): Promise<AnalyzeAccepted | { refused: ToolError }> {
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
      filename,
    );
    if (form.pages) fd.append("pages", form.pages);
    fd.append("save_as_template", form.saveAsTemplate ? "true" : "false");
    if (form.saveAsTemplate && form.access) fd.append("access", form.access);
    if (form.detectExtraBlanks) fd.append("detect_extra_blanks", "true");
    let res: Response;
    try {
      res = await this.doFetch(this.url("/forms/analyze"), {
        method: "POST",
        headers: this.headers({ Accept: "application/json" }),
        body: fd,
        redirect: "error",
      });
    } catch (e) {
      const code = causeCode(e);
      if (code && NOT_SENT_CODES.has(code)) throw networkError(e, this.origin);
      throw unknownOutcome();
    }
    if (res.status === 202) {
      try {
        return (await res.json()) as AnalyzeAccepted;
      } catch {
        throw unknownOutcome();
      }
    }
    const err = await errorFromResponse(res);
    // A gateway error without our envelope (502/504 from a proxy) may have hit
    // after the API created the job: the outcome is unknown.
    if (err.details.enveloped === false && res.status >= 500) throw unknownOutcome();
    if (res.status === 429) return { refused: err };
    throw err;
  }
}

/** A 429 that analyze already waited out (part of) in-process. */
function afterWaiting(err: ToolError, waitedMs: number): ToolError {
  const s = Math.round(waitedMs / 1000);
  const hint =
    err.code === "too_many_active_jobs"
      ? `Other analyses in this workspace are still running (free native-field ones count too); fenfill-mcp already waited ${String(s)} s. Try again in a minute, or analyze fewer documents at once.`
      : `fenfill-mcp already waited ${String(s)} s for capacity. ${err.hint ?? "Try again in a minute."}`;
  return new ToolError(err.code, err.message, {
    hint,
    status: err.status,
    details: { ...err.details, waited_s: s },
  });
}

/** A re-analysis POST cut off mid-flight: a run may have started. */
export function templateOutcomeUnknown(): ToolError {
  return new ToolError(
    "outcome_unknown",
    "The request to fenfill was interrupted and it's unknown whether the re-analysis started.",
    {
      hint: "A run may have started. Wait a minute or two, then check get_template (updated_at, pages[].analyzed): the pages may already be re-analyzed. Calling reanalyze_template again with the same arguments is safe: it re-sends the version this request started from, so fenfill refuses a second run (job_in_progress while one runs, template_conflict once it finished) instead of charging again.",
    },
  );
}

export function unknownOutcome(): ToolError {
  return new ToolError(
    "upload_outcome_unknown",
    "The upload to fenfill was interrupted and it's unknown whether the analysis started.",
    {
      hint: "To avoid paying twice, analyze_form won't re-upload this file for 10 minutes. Check get_account (scans_remaining) and list_templates, then call analyze_form again after that.",
    },
  );
}
