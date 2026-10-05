// reanalyze_template: re-analyze pages of a SAVED template from the blank PDF
// fenfill already stores with it (nothing is uploaded), then report what
// changed on those pages.
//
//   refuse while a local working copy exists (unless discard) → resume a run
//   this request already started → else read the template (before-state +
//   updated_at), lock, POST once {pages, kind?, expected_updated_at} → poll
//   within the wait budget → on done: drop the working copy (discard), refresh
//   the cached analyses of the template, read the after-state, diff.
//
// Money rules: the POST is never abortable and only an enveloped 429 refused
// before any job exists is re-sent (api.ts). fenfill runs one job per template
// (409 job_in_progress) and checks expected_updated_at (409 template_conflict),
// so a repeated request never starts, or pays for, a second run of the same
// version. The job id is recorded in pending/t-<tid>.<hash>.json as soon as it
// is known, so a call that runs out of budget returns status "running" and a
// repeat call with the same arguments resumes polling that job.
//
// PRIVACY: requests carry only the template id, pages, kind and version.

import { randomBytes } from "node:crypto";

import { holderAlive } from "./analyze.js";
import type { FenfillApi } from "./api.js";
import {
  type ApiIdentity,
  type Cache,
  type CachedAnalysis,
  editKeyForTemplate,
  PENDING_MAX_AGE_MS,
  pagesToSpec,
  rerunHash,
  sameAccount,
  STALE_LOCK_MS,
  type TemplatePendingEntry,
  type TemplatePendingRead,
  type WorkingCopy,
} from "./cache.js";
import { compactView } from "./compact.js";
import { ToolError } from "./errors.js";
import { log } from "./log.js";
import { parsePageSpec } from "./pages.js";
import { pollJobLoop, TERMINAL_POLL_CODES } from "./poll.js";
import type {
  AgentSchema,
  AnalyzeAccepted,
  JobBody,
  RenderSchema,
  RerunEstimate,
  RerunKind,
} from "./types.js";

export const RERUN_KINDS = ["scratch", "find", "relabel", "label_missing"] as const;

export interface ReanalyzeArgs {
  template_id: string;
  pages: string;
  kind?: RerunKind;
  estimate?: boolean;
  discard?: boolean;
}

export interface ReanalyzeDeps {
  cache: Cache;
  api: () => FenfillApi;
  identity: (fetchWs: boolean) => Promise<ApiIdentity | null>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitSeconds: number;
  /** Every live POST, for the shutdown drain. */
  posts: Set<Promise<unknown>>;
  owner: string;
  /** This account's working copy of a template, if any. */
  templateEdits: (templateId: string) => Promise<WorkingCopy | null>;
  /** Drop the unsaved-analysis copies of PDFs analyzed as this template. */
  dropFileCopies: (templateId: string) => Promise<void>;
}

export interface ReanalyzeCtx {
  signal: AbortSignal;
  progress?: (progress: number, message?: string) => Promise<void>;
}

const NEXT_RUNNING =
  "call reanalyze_template again with the same arguments: it resumes this run at no extra charge";
const NEXT_DONE =
  "Review the changed pages with preview_page {template_id, page} (or get_template with pages); correct anything wrong with edit_template, then save_template. fill_template and recipient links already use the new layout.";
const NEXT_NARROW =
  'Too many changes to list at once. Call get_template with `pages` (e.g. "2") to see them.';

// ---- the diff ------------------------------------------------------------------------------

export interface DiffItem {
  id: string;
  label: string | null;
  type: string;
}

export interface ChangedItem extends DiffItem {
  /** What changed: label, type, box, members (a group's cells/options/structure). */
  changes: string[];
  /** The previous label / type, when that changed. */
  was?: { label?: string | null; type?: string };
}

export interface PageChanges {
  page: number;
  added: DiffItem[];
  removed: DiffItem[];
  changed: ChangedItem[];
}

interface Item extends DiffItem {
  page: number | undefined;
  box: string;
  members: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type Field = RenderSchema["fields"][number];
type Group = RenderSchema["groups"][number];

function fieldType(f: Field): string {
  const t = typeof f.type === "string" ? f.type : "text";
  const variant = isRecord(f.format) ? f.format.variant : undefined;
  return t === "text" && variant === "multiline" ? "multiline" : t;
}

function groupType(g: Group): string {
  const kind = typeof g.kind === "string" ? g.kind : typeof g.type === "string" ? g.type : "group";
  if (kind === "choice") return g.multiple === true ? "multiselect" : "radio";
  if (kind === "table") return g.format === "expandable" ? "table_rows" : "table";
  return kind;
}

const labelOf = (x: Record<string, unknown>) => (typeof x.label === "string" ? x.label : null);

function boxOf(fs: readonly Field[]): string {
  if (!fs.length) return "";
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of fs) {
    x0 = Math.min(x0, num(f.xpct));
    y0 = Math.min(y0, num(f.ypct));
    x1 = Math.max(x1, num(f.xpct) + num(f.wpct));
    y1 = Math.max(y1, num(f.ypct) + num(f.hpct));
  }
  return [x0, y0, x1, y1].map(r3).join(",");
}

/** Standalone fields and groups (with their members folded in), by id. */
function items(render: RenderSchema): Map<string, Item> {
  const fields = Array.isArray(render.fields) ? render.fields : [];
  const groups = Array.isArray(render.groups) ? render.groups : [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out = new Map<string, Item>();
  const grouped = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g.id !== "string") continue;
    const ids = Array.isArray(g.members) ? (g.members as unknown[]) : [];
    const members = ids
      .map((id) => (typeof id === "string" ? byId.get(id) : undefined))
      .filter((f): f is Field => !!f);
    for (const m of members) grouped.add(m.id);
    const page = typeof g.page === "number" ? g.page : members[0]?.page;
    const structure = {
      m: members.map((f) => [f.id, fieldType(f), labelOf(f), boxOf([f])]),
      o: g.orientation ?? null,
      hc: g.header_cols ?? null,
      hr: g.header_rows ?? null,
      opts: g.options ?? null,
    };
    out.set(g.id, {
      id: g.id,
      label: labelOf(g),
      type: groupType(g),
      page,
      box: boxOf(members),
      members: JSON.stringify(structure),
    });
  }
  for (const f of fields) {
    if (!f || typeof f.id !== "string") continue;
    if (grouped.has(f.id) || (typeof f.group === "string" && f.group)) continue;
    out.set(f.id, {
      id: f.id,
      label: labelOf(f),
      type: fieldType(f),
      page: f.page,
      box: boxOf([f]),
      members: "",
    });
  }
  return out;
}

const plain = (i: Item): DiffItem => ({ id: i.id, label: i.label, type: i.type });

/**
 * What changed on `pages` between two versions of a template, per page, by id:
 * added, removed, and changed (label, type, box, or a group's members). A
 * group counts as one item; its members are folded into it. Only pages with a
 * change are listed, ascending.
 */
export function pageDiff(
  before: RenderSchema,
  after: RenderSchema,
  pages: readonly number[],
): PageChanges[] {
  const scope = new Set(pages);
  const a = items(before);
  const b = items(after);
  const byPage = new Map<number, PageChanges>();
  const at = (page: number) => {
    let pc = byPage.get(page);
    if (!pc) {
      pc = { page, added: [], removed: [], changed: [] };
      byPage.set(page, pc);
    }
    return pc;
  };
  const inScope = (p: number | undefined): p is number => p !== undefined && scope.has(p);
  for (const [id, old] of a) {
    const now = b.get(id);
    if (!now) {
      if (inScope(old.page)) at(old.page).removed.push(plain(old));
      continue;
    }
    const page = inScope(now.page) ? now.page : inScope(old.page) ? old.page : undefined;
    if (page === undefined) continue;
    const changes: string[] = [];
    const was: { label?: string | null; type?: string } = {};
    if (old.label !== now.label) {
      changes.push("label");
      was.label = old.label;
    }
    if (old.type !== now.type) {
      changes.push("type");
      was.type = old.type;
    }
    if (old.box !== now.box || old.page !== now.page) changes.push("box");
    if (old.members !== now.members) changes.push("members");
    if (changes.length) {
      at(page).changed.push({
        ...plain(now),
        changes,
        ...(Object.keys(was).length ? { was } : {}),
      });
    }
  }
  for (const [id, now] of b) {
    if (!a.has(id) && inScope(now.page)) at(now.page).added.push(plain(now));
  }
  return [...byPage.values()].sort((x, y) => x.page - y.page);
}

/** The analyzed / never-analyzed pages of a saved template's agent view. */
export function analyzedPagesOf(agent: AgentSchema): { analyzed: number[]; unanalyzed: number[] } {
  const analyzed: number[] = [];
  const unanalyzed: number[] = [];
  for (const p of Array.isArray(agent.pages) ? agent.pages : []) {
    if (!p || !Number.isInteger(p.page)) continue;
    (p.analyzed === false ? unanalyzed : analyzed).push(p.page);
  }
  return { analyzed: analyzed.sort((x, y) => x - y), unanalyzed: unanalyzed.sort((x, y) => x - y) };
}

// ---- the tool ------------------------------------------------------------------------------

interface Snapshot {
  agent: AgentSchema;
  render: RenderSchema;
  updated_at: string | null;
}

async function readTemplate(
  api: FenfillApi,
  templateId: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const { body } = await api.getJson<AgentSchema & { render?: RenderSchema }>(
    `/templates/${encodeURIComponent(templateId)}?include=render`,
    { signal },
  );
  const { render, ...agent } = body;
  if (!render || !Array.isArray(agent.fields)) {
    throw new ToolError("bad_response", "fenfill returned the template without its schema.", {
      hint: "Retry shortly.",
    });
  }
  return {
    agent: agent as AgentSchema,
    render,
    updated_at: typeof body.updated_at === "string" ? body.updated_at : null,
  };
}

function jobErrorHint(code: string): string {
  if (code === "no_fields_found") {
    return "fenfill found no fillable fields on those pages. The template is unchanged and any reserved scans are refunded.";
  }
  return "The template is unchanged and any reserved scans are refunded automatically. Call reanalyze_template again to retry.";
}

/** A poll error for this tool: the job-context hints speak of analyze_form. */
function rehint(e: unknown, jobId: string): unknown {
  if (!(e instanceof ToolError) || !TERMINAL_POLL_CODES.has(e.code)) return e;
  const hint =
    e.code === "template_frozen"
      ? "The template is frozen (the workspace is over its plan's template limit). Unfreeze it in fenfill (or upgrade), then check it with get_template."
      : "fenfill has no record of this run any more. Check get_template: if the pages didn't change, call reanalyze_template again (it starts, and charges for, a new run).";
  return new ToolError(e.code, e.message, {
    hint,
    status: e.status,
    details: { ...e.details, job_id: jobId },
  });
}

function running(jobId: string | null, progress = 0, phase: string | null = null) {
  return { status: "running", job_id: jobId, progress, phase, next: NEXT_RUNNING };
}

export async function reanalyzeTemplate(
  deps: ReanalyzeDeps,
  args: ReanalyzeArgs,
  ctx: ReanalyzeCtx,
): Promise<Record<string, unknown>> {
  const deadline = deps.now() + deps.waitSeconds * 1000;
  const tid = args.template_id;
  const kind = args.kind ?? null;
  const requested = parsePageSpec(args.pages);
  const spec = pagesToSpec(requested);
  const api = deps.api(); // a missing or malformed key fails here
  const retry = {
    signal: ctx.signal,
    onWait: (seconds: number, code: string) => {
      log("info", "reanalyze refused, waiting to retry", { code, seconds });
    },
  };

  // Estimate: prices the run, starts nothing (and needs no version).
  if (args.estimate === true) {
    const est = (await api.analyzeTemplate(
      tid,
      { pages: spec, ...(kind ? { kind } : {}), estimate: true },
      retry,
    )) as RerunEstimate;
    return {
      status: "estimate",
      template_id: tid,
      ...est,
      next: est.insufficient
        ? "Not enough page scans for this run: re-analyze fewer pages, or add scans in fenfill (Settings → Billing)."
        : "Call reanalyze_template again without estimate to run it.",
    };
  }

  // Local edits were made against the version this run replaces.
  if ((await deps.templateEdits(tid)) && args.discard !== true) {
    throw new ToolError(
      "local_edits_pending",
      "This template has unsaved local edits (edit_template), and re-analysis changes fenfill's copy under them.",
      {
        hint: "Save them first with save_template, or pass discard: true to drop them when the re-analysis finishes.",
      },
    );
  }

  const who = await deps.identity(true);
  if (!who) throw new ToolError("missing_api_key", "FENFILL_API_KEY is not set.");
  const oh = rerunHash(tid, spec, kind, who);

  // Resume a run this request already started; else lock + POST once.
  let jobId: string | null = null;
  let entry: TemplatePendingEntry | null = null;
  // A POST of this request that may have started a run we never heard back
  // from (its response was lost, or its process died before recording the job
  // id): re-sent with the version it was first sent with, so fenfill answers
  // job_in_progress / template_conflict instead of charging for a second run.
  let recovered: TemplatePendingEntry | null = null;
  let recoveredStamp: TemplatePendingRead["stamp"] | null = null;
  const prior = await deps.cache.readTemplatePending(tid, oh);
  if (prior) {
    const e = prior.entry;
    const mine = !!e && sameAccount(e, who) && prior.ageMs <= PENDING_MAX_AGE_MS;
    if (mine && e && typeof e.job_id === "string" && e.job_id) {
      jobId = e.job_id;
      entry = e;
      log("info", "resuming re-analysis", { job: jobId });
    } else if (mine && e && !e.unknown_outcome && prior.ageMs <= STALE_LOCK_MS && holderAlive(e)) {
      return running(null); // another call is posting it right now
    } else if (mine && e && typeof e.before_updated_at === "string" && e.before) {
      recovered = e;
      recoveredStamp = prior.stamp;
    } else {
      await deps.cache.removeTemplatePending(tid, oh, { stamp: prior.stamp });
    }
  }

  if (!jobId) {
    let beforeRender: RenderSchema;
    let version: string;
    let lock: TemplatePendingEntry;
    const token = randomBytes(8).toString("hex");
    const holder = { pid: process.pid, owner: deps.owner, token };
    if (recovered && recoveredStamp) {
      beforeRender = recovered.before as RenderSchema;
      version = recovered.before_updated_at as string;
      // Take the entry over (its first holder is gone or got no answer).
      lock = { ...recovered, ...holder };
      const cur = await deps.cache.readTemplatePending(tid, oh);
      if (!cur || cur.stamp.raw !== recoveredStamp.raw) return running(null); // taken meanwhile
      await deps.cache.updateTemplatePending(lock, oh);
      log("info", "re-sending a re-analysis of unknown outcome", {});
    } else {
      const before = await readTemplate(api, tid, ctx.signal);
      if (!before.updated_at) {
        throw new ToolError(
          "missing_version",
          "fenfill didn't say which version of this template it has.",
          {
            hint: "Retry shortly.",
          },
        );
      }
      parsePageSpec(args.pages, before.agent.page_count || null); // pages exist
      beforeRender = before.render;
      version = before.updated_at;
      lock = {
        v: 1,
        template_id: tid,
        pages: spec,
        kind,
        created_at: new Date(deps.now()).toISOString(),
        ...holder,
        api_origin: who.api_origin,
        account: who.account,
        before: beforeRender,
        before_updated_at: version,
      };
      if (!(await deps.cache.tryCreateTemplatePending(lock, oh))) return running(null);
    }
    const isRetry = !!recovered;
    const post = (async () => {
      let accepted: AnalyzeAccepted;
      try {
        accepted = (await api.analyzeTemplate(
          tid,
          { pages: spec, ...(kind ? { kind } : {}), expected_updated_at: version },
          retry,
        )) as AnalyzeAccepted;
      } catch (err) {
        const code = err instanceof ToolError ? err.code : "error";
        log("warn", "reanalyze request failed", { code });
        if (code === "outcome_unknown" || (isRetry && KEEP_ON_RETRY.has(code))) {
          // A run may exist: keep the version it was sent with (until the
          // marker's 24 h TTL), so a repeat never charges for a second one.
          await deps.cache
            .updateTemplatePending(
              { ...lock, unknown_outcome: true, failed_at: new Date(deps.now()).toISOString() },
              oh,
            )
            .catch(() => undefined);
          if (isRetry && err instanceof ToolError) throw recoveredError(err);
        } else {
          await deps.cache.removeTemplatePending(tid, oh, { token }).catch(() => false);
        }
        throw err;
      }
      const recorded: TemplatePendingEntry = {
        ...lock,
        before: beforeRender,
        job_id: accepted.job_id,
        cost: typeof accepted.cost === "number" ? accepted.cost : 0,
      };
      delete recorded.unknown_outcome;
      delete recorded.failed_at;
      await deps.cache.updateTemplatePending(recorded, oh);
      log("info", "re-analysis queued", { job: accepted.job_id, cost: recorded.cost ?? 0 });
      return recorded;
    })();
    deps.posts.add(post);
    const settle = () => deps.posts.delete(post);
    post.then(settle, settle);
    entry = await post;
    jobId = jobIdOf(entry);
  }

  // Poll within the budget.
  const job = jobId;
  const pend = async () => {
    const p = await deps.cache.readTemplatePending(tid, oh).catch(() => null);
    return p?.entry && p.entry.job_id === job ? p.entry : null;
  };
  let errs = typeof entry?.poll_errors === "number" ? entry.poll_errors : 0;
  let out;
  try {
    out = await pollJobLoop({
      api,
      now: deps.now,
      sleep: deps.sleep,
      jobId: job,
      deadline,
      signal: ctx.signal,
      progress: ctx.progress,
      pollErrors: errs,
      store: {
        record: async () => {
          const e = await pend();
          errs = (e ? (typeof e.poll_errors === "number" ? e.poll_errors : 0) : errs) + 1;
          if (e) {
            await deps.cache.updateTemplatePending({ ...e, poll_errors: errs }, oh).catch(() => 0);
          }
          return errs;
        },
        reset: async () => {
          const e = await pend();
          if (e?.poll_errors) {
            await deps.cache.updateTemplatePending({ ...e, poll_errors: 0 }, oh).catch(() => 0);
          }
        },
        clear: () => deps.cache.removeTemplatePending(tid, oh, { job_id: job }).catch(() => false),
      },
      hints: {
        dropped: (n) =>
          `fenfill failed to report this re-analysis ${String(n)} times in a row, so it was dropped. Check get_template: if the pages didn't change, call reanalyze_template again.`,
        badDone: "Call reanalyze_template again with the same arguments; it resumes this run.",
        jobError: jobErrorHint,
        cancelled:
          "The re-analysis keeps running: call reanalyze_template again with the same arguments to follow it at no extra charge.",
      },
    });
  } catch (e) {
    throw rehint(e, job);
  }
  if ("running" in out) return running(job, out.running.progress, out.running.phase);
  return finish(deps, { args, tid, kind, requested, spec, oh, entry, body: out.done, who, ctx });
}

/**
 * On a re-sent POST of unknown outcome, the refusals that mean the first run
 * may exist (still running, finished, or not knowable yet): the marker and its
 * version stay. Any other refusal (e.g. 402) comes after fenfill's version and
 * one-job checks, so no earlier run is pending or done: the marker goes.
 */
const KEEP_ON_RETRY = new Set([
  "template_conflict",
  "job_in_progress",
  "rate_limited",
  "daily_limit",
  "too_many_active_jobs",
  "queue_full",
]);

/** A refusal of a re-sent POST, worded for what it means there. */
function recoveredError(err: ToolError): ToolError {
  if (err.code === "template_conflict") {
    return new ToolError(
      "template_conflict",
      "The template changed in fenfill since this re-analysis was first sent: the earlier run most likely finished.",
      {
        hint: "Check get_template (updated_at, and pages[].analyzed / unanalyzed_pages): the pages are probably re-analyzed already. Repeating this exact request won't start, or charge for, another run for 24 h after it was first sent.",
        status: err.status,
        details: { ...err.details, earlier_run_likely_finished: true },
      },
    );
  }
  if (err.code === "job_in_progress") {
    return new ToolError(err.code, err.message, {
      hint: "The earlier run of this request is most likely still going. Wait a minute or two, then check get_template (updated_at, pages[].analyzed). Calling reanalyze_template again with the same arguments is safe: it re-sends the original version, so it can't start a second run.",
      status: err.status,
      details: err.details,
    });
  }
  return err;
}

function jobIdOf(e: TemplatePendingEntry): string {
  if (!e.job_id) throw new ToolError("internal_error", "The re-analysis wasn't recorded.");
  return e.job_id;
}

async function finish(
  deps: ReanalyzeDeps,
  f: {
    args: ReanalyzeArgs;
    tid: string;
    kind: string | null;
    requested: number[];
    spec: string;
    oh: string;
    entry: TemplatePendingEntry | null;
    body: JobBody;
    who: ApiIdentity;
    ctx: ReanalyzeCtx;
  },
): Promise<Record<string, unknown>> {
  const { tid, body } = f;
  const jobId = body.job_id;
  await deps.cache.removeTemplatePending(tid, f.oh, { job_id: f.entry?.job_id ?? jobId });

  // The working copy was based on the version this run replaced.
  let discarded = false;
  if (f.args.discard === true) {
    discarded = await deps.cache.deleteEdits(editKeyForTemplate(tid));
    await deps.dropFileCopies(tid).catch(() => undefined);
  }

  // The template now: re-read (the job's copy if that fails).
  let after: Snapshot;
  try {
    after = await readTemplate(deps.api(), tid, f.ctx.signal);
  } catch {
    const result = body.result as AgentSchema;
    after = {
      agent: result,
      render: body.render as RenderSchema,
      updated_at: typeof result.updated_at === "string" ? result.updated_at : null,
    };
  }
  const { analyzed, unanalyzed } = analyzedPagesOf(after.agent);
  await refreshTemplateAnalyses(deps, tid, after, f.requested, analyzed, f.who).catch(
    () => undefined,
  );

  const before = f.entry?.before;
  const changed = before ? pageDiff(before, after.render, f.requested) : null;
  const changedPages = changed ? changed.map((c) => c.page) : f.requested;
  const cost = typeof body.cost === "number" ? body.cost : (f.entry?.cost ?? 0);
  return {
    status: "done",
    job_id: jobId,
    kind: f.kind ?? "scratch",
    cost,
    template_id: tid,
    updated_at: after.updated_at,
    reanalyzed_pages: f.spec,
    analyzed_pages: analyzed,
    ...(unanalyzed.length ? { unanalyzed_pages: unanalyzed } : {}),
    ...(f.args.discard === true ? { discarded } : {}),
    ...(changed
      ? { changed_pages: changed }
      : {
          changed_pages_note: "The earlier state wasn't recorded, so the pages are listed whole.",
        }),
    ...(changedPages.length
      ? compactView(after.agent, changedPages, NEXT_NARROW)
      : { note: `No field changed on pages ${f.spec}.` }),
    next: NEXT_DONE,
  };
}

/**
 * The cached analyses of this template (forms/<sha>/*.s-<tid>.json) now show
 * the new layout, and also cover the pages this run analyzed: analyze_form on
 * the template's PDF then serves them free instead of paying again.
 */
async function refreshTemplateAnalyses(
  deps: ReanalyzeDeps,
  tid: string,
  after: Snapshot,
  requested: readonly number[],
  analyzed: readonly number[],
  who: ApiIdentity,
): Promise<void> {
  const done = new Set(analyzed);
  const gained = requested.filter((p) => done.has(p));
  const at = new Date(deps.now()).toISOString();
  for (const sha of await deps.cache.formShas()) {
    for (const e of await deps.cache.listAnalyses(sha)) {
      if (e.template_id !== tid || !sameAccount(e, who)) continue;
      const pages = [...new Set([...e.pages, ...gained])].sort((x, y) => x - y);
      const next: CachedAnalysis = {
        ...e,
        pages,
        render: after.render,
        agent: {
          ...after.agent,
          template_id: tid,
          ...(after.updated_at ? { updated_at: after.updated_at } : {}),
        },
        at,
      };
      delete next.served_at;
      await deps.cache.saveAnalysis(next);
      if (pages.length !== e.pages.length) await deps.cache.deleteAnalysis(e);
    }
  }
}
