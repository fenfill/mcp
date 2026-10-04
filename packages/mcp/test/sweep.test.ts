// H2: the background cache sweep (injected clock), and H1: the cache root is private.

import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Cache, optionsHash, type PendingEntry, sha256Hex } from "../src/cache.js";
import { sweepCache } from "../src/sweep.js";
import { connect, env, MockApi, tmp, virtualClock } from "./helpers.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const IS_WIN = process.platform === "win32";

let t: ReturnType<typeof tmp>;
let root: string;
beforeEach(() => {
  t = tmp();
  root = join(t.dir, "cache");
});
afterEach(() => t.cleanup());

/** Write `rel` under the cache root with an mtime `ageMs` before `now`. */
function file(rel: string, now: number, ageMs: number, data = "x"): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
  const s = (now - ageMs) / 1000;
  utimesSync(p, s, s);
  return p;
}

describe("sweepCache", () => {
  it("drops only what can no longer be useful", async () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const cache = new Cache(root, () => now);
    const sha = "b".repeat(64);
    const keep: string[] = [];
    const gone: string[] = [];
    gone.push(file("templates/t-old/blank.pdf", now, 2 * HOUR));
    keep.push(file("templates/t-new/blank.pdf", now, 10 * 60 * 1000));
    gone.push(file("account/ws-old/logo.bin", now, 2 * HOUR));
    keep.push(file("account/ws-new/logo.bin", now, 30 * 60 * 1000));
    gone.push(file(`forms/${"c".repeat(64)}/p1.u.json`, now, 91 * DAY));
    keep.push(file(`forms/${sha}/p1.u.json`, now, 89 * DAY));
    gone.push(file(`outputs/${"d".repeat(64)}`, now, 366 * DAY));
    keep.push(file(`outputs/${"e".repeat(64)}`, now, 300 * DAY));
    gone.push(file("pending/.0123456789abcdef.tomb", now, 2 * DAY));

    // Pending: old + dead holder → gone; old + live holder → kept; young → kept.
    const pending = async (opts: { pages: string | null }, hoursOld: number, pid: number) => {
      const options = { pages: opts.pages, save_as_template: false };
      const entry: PendingEntry = {
        v: 1,
        sha256: sha,
        options,
        created_at: new Date(now - hoursOld * HOUR).toISOString(),
        pid,
        job_id: "j",
      };
      await cache.updatePending(entry, optionsHash(options));
      return join(root, "pending", `${sha}.${optionsHash(options)}.json`);
    };
    gone.push(await pending({ pages: null }, 49, 999_999_999));
    keep.push(await pending({ pages: "1" }, 49, process.ppid)); // a live process
    keep.push(await pending({ pages: "2" }, 47, 999_999_999));

    const removed = await sweepCache(cache, now);
    for (const p of gone) expect(existsSync(p), p).toBe(false);
    for (const p of keep) expect(existsSync(p), p).toBe(true);
    expect(removed).toBe(gone.length);
    // Emptied folders go too.
    expect(existsSync(join(root, "templates", "t-old"))).toBe(false);
    expect(existsSync(join(root, "forms", "c".repeat(64)))).toBe(false);
  });

  it("a served form is kept: serving touches its analyses", async () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const sha = "f".repeat(64);
    const p = file(`forms/${sha}/p1.u.json`, now, 100 * DAY);
    await new Cache(root, () => now).touchForm(sha);
    expect(Math.abs(statSync(p).mtimeMs - now)).toBeLessThan(1000);
    await sweepCache(new Cache(root, () => now + 89 * DAY), now + 89 * DAY);
    expect(existsSync(p)).toBe(true);
  });

  it("never throws, even on a cache it can't read", async () => {
    writeFileSync(join(t.dir, "not-a-dir"), "x");
    await expect(sweepCache(new Cache(join(t.dir, "not-a-dir")), Date.now())).resolves.toBe(0);
    await expect(sweepCache(new Cache(join(t.dir, "missing")), Date.now())).resolves.toBe(0);
  });

  it("the server sweeps at startup and at most once a day, off the tool path", async () => {
    const clock = virtualClock();
    const old = file("templates/t-old/blank.pdf", clock.now(), 2 * HOUR);
    const c = await connect({ env: env(root), fetchImpl: new MockApi().fetch, ...clock });
    try {
      for (let i = 0; i < 50 && existsSync(old); i++) await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(old)).toBe(false); // startup
      const again = file("templates/t-2/blank.pdf", clock.now(), 2 * HOUR);
      await c.call("get_account", {}); // same day: no sweep
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(again)).toBe(true);
      clock.advance(DAY + 1);
      const fresh = file("templates/t-3/blank.pdf", clock.now(), 2 * HOUR);
      await c.call("get_account", {}); // a day later: sweeps again
      for (let i = 0; i < 50 && existsSync(fresh); i++) await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await c.close();
    }
  });

  it("a sweep failure never reaches a tool call", async () => {
    // The cache root is a FILE: every sweep step fails; fill_form still answers.
    writeFileSync(root, "x");
    const c = await connect({ env: { FENFILL_CACHE_DIR: root } });
    try {
      const r = await c.call("fill_form", {
        path: join(t.dir, "nope.pdf"),
        values: {},
        output_path: join(t.dir, "o.pdf"),
      });
      expect(r.data.error).toMatchObject({ code: "file_not_found" });
    } finally {
      await c.close();
    }
  });
});

describe.skipIf(IS_WIN)("the cache root is private (H1)", () => {
  it("an existing, too-open cache root is tightened to 0700", async () => {
    mkdirSync(root, { mode: 0o755 });
    expect(statSync(root).mode & 0o777).toBe(0o755);
    await new Cache(root).registerOutput(sha256Hex("x"));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(root)).toEqual(["outputs"]);
  });
});
