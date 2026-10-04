// Shared test scaffolding: fixtures, PDF builders, a recording /v1 mock and an
// in-memory MCP client ↔ server pair.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument } from "pdf-lib";

import { type ApiIdentity, keyFingerprint } from "../src/cache.js";
import { createFenfillServer, type ServerOptions } from "../src/server.js";
import type { AgentSchema, RenderSchema } from "../src/types.js";

export const REPO = resolve(__dirname, "../../..");
export const FIXTURES = join(REPO, "tests/fixtures/agent_schema");
export const FONTS_DIR = join(REPO, "public/fonts");
export const API_KEY = `ff_live_${"a".repeat(43)}`;
export const API_URL = "https://api.test.invalid";

/** The identity a test server (env() below) tags its cache entries with. */
export function testIdentity(workspaceId: string | null = null, apiKey = API_KEY): ApiIdentity {
  return {
    api_origin: API_URL,
    account: { workspace_id: workspaceId, key_sha: keyFingerprint(apiKey) },
  };
}

export function fixture(name: string): { render: RenderSchema; agent: AgentSchema } {
  const render = JSON.parse(
    readFileSync(join(FIXTURES, `${name}.input.json`), "utf8"),
  ) as RenderSchema;
  const agent = JSON.parse(
    readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8"),
  ) as AgentSchema & {
    _parity?: unknown;
  };
  delete agent._parity;
  return { render, agent };
}

/** Re-id every field/group of a render + agent pair, as a fresh analysis would. */
export function reId(render: RenderSchema, agent: AgentSchema, tag: string) {
  const map = (id: string) => `${tag}-${id}`;
  const r: RenderSchema = JSON.parse(JSON.stringify(render));
  for (const f of r.fields) {
    f.id = map(f.id);
    if (typeof f.group === "string") f.group = map(f.group);
  }
  for (const g of r.groups) {
    g.id = map(g.id);
    if (Array.isArray(g.members)) g.members = (g.members as string[]).map(map);
    if (Array.isArray(g.grid)) {
      g.grid = (g.grid as unknown[]).map((row) =>
        Array.isArray(row) ? row.map((id) => (typeof id === "string" ? map(id) : id)) : row,
      );
    }
  }
  const a: AgentSchema = JSON.parse(JSON.stringify(agent));
  for (const e of a.fields) {
    e.id = map(e.id);
    for (const k of ["options", "cells", "columns"]) {
      const list = e[k];
      if (Array.isArray(list)) for (const x of list as { id: string }[]) x.id = map(x.id);
    }
  }
  return { render: r, agent: a };
}

/** A blank PDF whose pages match a render schema's page list (px → pt 1:1). */
export async function pdfFor(render: RenderSchema, extraText?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pages = [...new Map(render.pages.map((p) => [p.page, p])).values()].sort(
    (a, b) => a.page - b.page,
  );
  const last = pages.length ? pages[pages.length - 1].page : 1;
  for (let n = 1; n <= last; n++) {
    const p = pages.find((x) => x.page === n);
    const w = typeof p?.width === "number" ? p.width : 612;
    const h = typeof p?.height === "number" ? p.height : 792;
    const page = doc.addPage([w, h]);
    if (extraText) page.drawText(extraText, { x: 20, y: 20, size: 8 });
  }
  return doc.save();
}

/** CRC-32 (IEEE, as PNG chunks use it). Inline: zlib.crc32 needs Node ≥ 22.2. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A valid, opaque 8-bit RGB PNG (two colour bands), e.g. a logo or a signature image. */
export function pngBytes(width = 64, height = 32): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, no filter, no interlace
  const row = 1 + width * 3; // each scanline: filter byte 0 + RGB pixels
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(x < width / 2 ? [0x1f, 0x3a, 0x93] : [0xf2, 0xb1, 0x34], y * row + 1 + x * 3);
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(png); // a copy on its own ArrayBuffer (a valid fetch BodyInit)
}

export async function plainPdf(pages = 1, marker = "blank"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    doc.addPage([612, 792]).drawText(marker, { x: 20, y: 20, size: 8 });
  return doc.save();
}

export function tmp(prefix = "fenfill-mcp-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- a recording /v1 mock -----------------------------------------------------------------

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (req: Recorded, m: RegExpMatchArray) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const apiError = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => json(status, { error: { code, message: `${code} happened`, ...extra } }, headers);

async function bodyText(body: unknown): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      if (typeof v === "string") parts.push(`${k}=${v}`);
      else parts.push(`${k}=${v.name}:${Buffer.from(await v.arrayBuffer()).toString("latin1")}`);
    }
    return parts.join("\n");
  }
  if (body instanceof Uint8Array) return Buffer.from(body).toString("latin1");
  return String(body);
}

export class MockApi {
  readonly calls: Recorded[] = [];
  private routes: { method: string; re: RegExp; handler: Handler }[] = [];

  on(method: string, re: RegExp, handler: Handler): this {
    this.routes.push({ method, re, handler });
    return this;
  }

  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(new URL(c.url).pathname)).length;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const rec: Recorded = { method, url, headers, body: await bodyText(init?.body) };
    this.calls.push(rec);
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return r.handler(rec, m);
    }
    return apiError(404, "not_found");
  }) as typeof fetch;

  /** A standard analyze flow: POST → job id; each GET walks `states`, then done. */
  analyzeFlow(opts: {
    jobId: string;
    render: RenderSchema;
    agent: AgentSchema;
    pages: number[];
    mode?: "ai" | "acroform";
    cost?: number;
    templateId?: string | null;
    states?: ("queued" | "running")[];
  }): this {
    const states = [...(opts.states ?? [])];
    this.on("POST", /^\/v1\/forms\/analyze$/, () =>
      json(202, {
        job_id: opts.jobId,
        status: "queued",
        mode: opts.mode ?? "ai",
        pages: opts.pages,
        cost: opts.cost ?? opts.pages.length,
      }),
    );
    this.on("GET", new RegExp(`^/v1/jobs/${opts.jobId}\\?include=render$`), () => {
      const st = states.shift();
      const base = {
        job_id: opts.jobId,
        mode: opts.mode ?? "ai",
        pages: opts.pages,
        cost: opts.cost ?? opts.pages.length,
        created_at: "2026-09-29T00:00:00Z",
        error: null,
      };
      if (st) {
        return json(
          200,
          {
            ...base,
            status: st,
            phase: st === "queued" ? null : "labels",
            progress: st === "queued" ? 0 : 40,
            template_id: null,
            result: null,
          },
          { "retry-after": st === "queued" ? "10" : "3" },
        );
      }
      return json(200, {
        ...base,
        status: "done",
        phase: "done",
        progress: 100,
        template_id: opts.templateId ?? null,
        result: { ...opts.agent, template_id: opts.templateId ?? null },
        render: opts.render,
      });
    });
    return this;
  }
}

// ---- virtual time ----------------------------------------------------------------------------

/** A clock whose sleeps advance virtual time and yield one real tick. */
export function virtualClock(start = Date.parse("2026-09-29T12:00:00Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      t += ms;
      await new Promise((r) => setImmediate(r));
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    },
  };
}

// ---- MCP client ↔ server ------------------------------------------------------------------------

export interface Connected {
  client: Client;
  call: (
    name: string,
    args: Record<string, unknown>,
    opts?: {
      onprogress?: (p: { progress: number; total?: number }) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{ isError: boolean; data: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export async function connect(
  opts: ServerOptions & { tap?: (message: unknown) => void } = {},
): Promise<Connected> {
  const { tap, ...serverOpts } = opts;
  const { server, shutdown } = createFenfillServer({ fontsDir: FONTS_DIR, ...serverOpts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  if (tap) {
    // Every message the server sends (results, notifications) passes the tap.
    const send = serverT.send.bind(serverT);
    serverT.send = async (message, o) => {
      tap(message);
      return send(message, o);
    };
  }
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    call: async (name, args, o) => {
      const r = await client.callTool({ name, arguments: args }, undefined, {
        onprogress: o?.onprogress,
        signal: o?.signal,
        timeout: 120_000,
      });
      const content = r.content as { type: string; text: string }[];
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(content[0].text) as Record<string, unknown>;
      } catch {
        data = { raw: content[0].text }; // an SDK-level error (e.g. input validation)
      }
      return { isError: r.isError === true, data };
    },
    close: async () => {
      await client.close();
      await shutdown(1000);
    },
  };
}

export function env(cacheDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    FENFILL_API_KEY: API_KEY,
    FENFILL_API_URL: API_URL,
    FENFILL_CACHE_DIR: cacheDir,
    ...extra,
  };
}
