// L6: stdin close, SIGTERM and SIGINT all run the same drain; a second signal
// exits at once.

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { installShutdown, type ShutdownHost } from "../src/lifecycle.js";

function fakeHost() {
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  const exits: number[] = [];
  const host: ShutdownHost = {
    on: (event, fn) => proc.on(event, fn),
    stdin: { on: (event, fn) => stdin.on(event, fn) },
    exit: (code) => {
      exits.push(code ?? 0);
    },
  };
  let finish!: () => void;
  let drains = 0;
  const drain = () => {
    drains++;
    return new Promise<void>((r) => (finish = r));
  };
  const close = installShutdown(host, drain);
  return {
    proc,
    stdin,
    exits,
    close,
    drains: () => drains,
    finish: async () => {
      finish();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("shutdown wiring", () => {
  it.each(["SIGTERM", "SIGINT"])("%s drains, then exits 0", async (sig) => {
    const h = fakeHost();
    h.proc.emit(sig);
    expect(h.drains()).toBe(1);
    expect(h.exits).toEqual([]); // still draining
    await h.finish();
    expect(h.exits).toEqual([0]);
  });

  it("a second signal exits at once, mid-drain", () => {
    const h = fakeHost();
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGINT");
    expect(h.drains()).toBe(1);
    expect(h.exits).toEqual([130]);
    const t = fakeHost();
    t.proc.emit("SIGINT");
    t.proc.emit("SIGTERM");
    expect(t.exits).toEqual([143]);
  });

  it("stdin closing then the client's SIGTERM is ONE drain (the first signal waits for it)", async () => {
    const h = fakeHost();
    h.stdin.emit("end");
    h.stdin.emit("close");
    h.close(); // the transport's onclose
    h.proc.emit("SIGTERM");
    expect(h.drains()).toBe(1);
    expect(h.exits).toEqual([]);
    await h.finish();
    expect(h.exits).toEqual([0]);
  });

  it("a failing drain still exits", async () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    installShutdown(
      {
        on: (e, fn) => proc.on(e, fn),
        stdin: { on: () => undefined },
        exit: (c) => {
          exits.push(c ?? 0);
        },
      },
      () => Promise.reject(new Error("boom")),
    );
    proc.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([0]);
  });
});
