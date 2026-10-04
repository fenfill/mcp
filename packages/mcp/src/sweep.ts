// Best-effort cache hygiene, run in the background at startup and at most once
// a day per server: it deletes what can no longer be useful and never throws.
//
//   templates/*/blank.pdf, account/*/logo.bin   past their 1 h TTL
//   forms/<sha>/*.json                          not served or written for 90 days
//   pending/*.json                              older than 48 h, holder not alive
//                                               (a live lock is never touched)
//   outputs/<sha>                               older than 365 days (the PDF's own
//                                               Info tag is the primary guard)
//   edits/*.json                                not edited for 90 days
//
// Ages come from file mtimes (analyses are touched when served) against the
// injected clock; pending entries use their own created_at.

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import { holderAlive } from "./analyze.js";
import { ASSET_TTL_MS, type Cache } from "./cache.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const SWEEP_INTERVAL_MS = DAY;
export const FORM_UNUSED_MS = 90 * DAY;
export const PENDING_SWEEP_MS = 48 * HOUR;
export const OUTPUT_MARKER_MS = 365 * DAY;
/** Leftover temp files and tombstones of a crashed write. */
const LEFTOVER_MS = DAY;

async function names(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function ageMs(path: string, now: number): Promise<number | null> {
  try {
    const st = await fsp.stat(path);
    return st.isFile() ? now - st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Remove `path` when it is a file older than `maxAgeMs`. true = removed. */
async function dropIfOld(path: string, now: number, maxAgeMs: number): Promise<boolean> {
  const age = await ageMs(path, now);
  if (age === null || age <= maxAgeMs) return false;
  await fsp.rm(path, { force: true });
  return true;
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  if ((await names(dir)).length === 0) await fsp.rmdir(dir).catch(() => undefined);
}

/** Per-file errors are swallowed: one bad entry never stops the rest. */
async function each(items: string[], fn: (name: string) => Promise<void>): Promise<void> {
  for (const n of items) await fn(n).catch(() => undefined);
}

export async function sweepCache(cache: Cache, now: number): Promise<number> {
  let removed = 0;
  const root = cache.root;
  const count = (b: boolean) => {
    if (b) removed++;
  };

  // Blank template PDFs and the logo: 1 h TTL.
  for (const [sub, file] of [
    ["templates", "blank.pdf"],
    ["account", "logo.bin"],
  ] as const) {
    await each(await names(join(root, sub)), async (id) => {
      const d = join(root, sub, id);
      count(await dropIfOld(join(d, file), now, ASSET_TTL_MS));
      await each(await names(d), async (n) => {
        if (n.startsWith(".")) count(await dropIfOld(join(d, n), now, LEFTOVER_MS));
      });
      await rmdirIfEmpty(d);
    });
  }

  // Analyses nobody used for 90 days.
  await each(await names(join(root, "forms")), async (sha) => {
    const d = join(root, "forms", sha);
    await each(await names(d), async (n) => {
      const max = n.startsWith(".") ? LEFTOVER_MS : FORM_UNUSED_MS;
      count(await dropIfOld(join(d, n), now, max));
    });
    await rmdirIfEmpty(d);
  });

  // Pending entries past 48 h whose holder is gone (results live 24 h).
  const pendDir = join(root, "pending");
  await each(await names(pendDir), async (n) => {
    if (n.startsWith(".")) {
      count(await dropIfOld(join(pendDir, n), now, LEFTOVER_MS));
      return;
    }
    const m = /^([0-9a-f]{64})\.([0-9a-f]{16})\.json$/.exec(n);
    if (!m) return;
    const p = await cache.readPending(m[1], m[2]);
    if (!p || p.ageMs <= PENDING_SWEEP_MS) return;
    if (p.entry && holderAlive(p.entry)) return;
    count(await cache.removePending(m[1], m[2], { stamp: p.stamp }));
  });

  // Working copies nobody edited for 90 days.
  await each(await names(join(root, "edits")), async (n) => {
    const max = n.startsWith(".") ? LEFTOVER_MS : FORM_UNUSED_MS;
    count(await dropIfOld(join(root, "edits", n), now, max));
  });

  // Output markers: a year.
  await each(await names(join(root, "outputs")), async (n) => {
    count(await dropIfOld(join(root, "outputs", n), now, OUTPUT_MARKER_MS));
  });

  return removed;
}
