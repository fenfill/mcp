// The job poll loop shared by analyze_form and reanalyze_template:
// GET /v1/jobs/{id}?include=render until done, an error, or the wait budget.
//
//  - Retry-After decides the next poll (else 10 s queued, 3 s running); a poll
//    that would end past the deadline returns `running` instead.
//  - A transient failure (network, 401, 429, 503) is retried on the next call
//    and never counted; any other failure is counted against the job through
//    the caller's store, and MAX_POLL_ERRORS in a row drop it.
//  - A failure that means the result will never come (TERMINAL_POLL_CODES) and
//    a job that ended in error clear the caller's pending entry at once.
//
// The caller owns the pending entry (where it lives, how errors are counted)
// and the wording of every hint.

import type { FenfillApi } from "./api.js";
import { ToolError } from "./errors.js";
import { log } from "./log.js";
import type { JobBody } from "./types.js";

/** Consecutive non-retryable poll failures before a pending job is dropped. */
export const MAX_POLL_ERRORS = 3;
/** A poll error that means the job's result will never come. */
export const TERMINAL_POLL_CODES = new Set(["result_expired", "not_found", "template_frozen"]);

/** A poll failure that says nothing about the job itself: retry it forever. */
export function transientPollError(e: ToolError): boolean {
  if (e.code === "bad_response") return false; // a 2xx we can't read
  if (e.status === undefined) return true; // network, timeout, cancelled
  return e.status === 401 || e.status === 429 || e.status === 503 || e.code === "rate_limited";
}

export interface PollSpec {
  api: FenfillApi;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  jobId: string;
  deadline: number;
  signal: AbortSignal;
  progress?: (progress: number, message?: string) => Promise<void>;
  /** Failed polls already recorded against this job. */
  pollErrors: number;
  /** The caller's pending entry for this job. */
  store: {
    /** Count one failure; returns the new consecutive count. */
    record: () => Promise<number>;
    reset: () => Promise<void>;
    clear: () => Promise<unknown>;
  };
  hints: {
    /** After MAX_POLL_ERRORS failures in a row (the job is dropped). */
    dropped: (n: number) => string;
    /** A finished job without its schema. */
    badDone: string;
    /** The job ended in error with this code. */
    jobError: (code: string) => string;
    /** The call was cancelled while waiting. */
    cancelled: string;
  };
}

export type PollOutcome =
  | { done: JobBody }
  | { running: { progress: number; phase: string | null } };

export async function pollJobLoop(spec: PollSpec): Promise<PollOutcome> {
  const { api, jobId, store, hints } = spec;
  // Count a failure against the job; after MAX_POLL_ERRORS in a row, drop it.
  const failed = async (err: ToolError): Promise<never> => {
    const n = await store.record();
    if (n < MAX_POLL_ERRORS) throw err;
    await store.clear();
    log("warn", "analysis dropped", { job: jobId, code: err.code });
    throw new ToolError(err.code, err.message, {
      hint: hints.dropped(n),
      status: err.status,
      details: { ...err.details, job_id: jobId },
    });
  };
  let cleanStreak = spec.pollErrors === 0;
  let last = -1;
  for (;;) {
    let got;
    try {
      got = await api.getJson<JobBody>(`/jobs/${encodeURIComponent(jobId)}?include=render`, {
        signal: spec.signal,
        deadline: spec.deadline,
      });
    } catch (e) {
      if (e instanceof ToolError && !transientPollError(e)) {
        // Terminal for this job id: forget it, so the next call starts afresh.
        if (TERMINAL_POLL_CODES.has(e.code)) {
          await store.clear();
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
          hint: hints.badDone,
        }),
      );
    }
    if (!cleanStreak) {
      cleanStreak = true;
      await store.reset();
    }
    if (body.status === "error") {
      const err = body.error ?? { code: "internal_error", message: "The analysis failed." };
      await store.clear();
      log("warn", "analysis failed", { job: jobId, code: err.code });
      throw new ToolError(err.code, err.message, {
        hint: hints.jobError(err.code),
        details: { job_id: jobId },
      });
    }
    const progress = typeof body.progress === "number" ? body.progress : 0;
    if (spec.progress && progress > last) {
      last = progress;
      await spec.progress(progress, body.phase ?? body.status).catch(() => undefined);
    }
    const ra = Number(got.headers.get("retry-after"));
    const waitS = Number.isFinite(ra) && ra > 0 ? ra : body.status === "queued" ? 10 : 3;
    if (spec.now() + waitS * 1000 > spec.deadline) {
      return { running: { progress, phase: body.phase ?? body.status } };
    }
    try {
      await spec.sleep(waitS * 1000, spec.signal);
    } catch {
      throw new ToolError("cancelled", "The call was cancelled.", { hint: hints.cancelled });
    }
  }
}
