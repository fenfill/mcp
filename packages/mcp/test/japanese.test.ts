// Japanese printing (fill_form / preview_page / stampAndWrite): the Noto Sans JP
// face is fetched on demand, sha256-pinned and cached. The real face
// (public/fonts) is the fixture, served by a mock fetch or pre-seeded into a tmp
// cache; no test reaches the network.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Cache } from "../src/cache.js";
import { ToolError } from "../src/errors.js";
import { stampAndWrite } from "../src/fill.js";
import { loadFonts } from "../src/fonts.js";
import { ensureJpFace, JP_FONT_FILE, jpFontPath, type JpFontError } from "../src/jpFont.js";
import {
  connect,
  type Connected,
  env,
  fixture,
  FONTS_DIR,
  MockApi,
  pdfFor,
  tmp,
  virtualClock,
} from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const ADDRESS = "東京都新宿区西新宿二丁目8番1号";
const NAME = "山田 Taro 1990年";
const IS_WIN = process.platform === "win32";
// The public mirror doesn't carry the 5.8 MB face, so these suites skip there.
const HAS_FACE = existsSync(join(FONTS_DIR, "NotoSansJP-Regular.ttf"));
const FACE = HAS_FACE
  ? new Uint8Array(readFileSync(join(FONTS_DIR, "NotoSansJP-Regular.ttf")))
  : new Uint8Array();
const FONT_URL = "https://fonts.test.invalid/NotoSansJP-Regular.ttf";

const { render, agent } = fixture("ungrouped_fields");
const idOf = (label: string) => agent.fields.find((e) => e.label === label)!.id;
const nameId = idOf("City"); // (the "Full name" box upper-cases Latin)
const cityId = idOf("Country");

let t: ReturnType<typeof tmp>;
let n = 0;
const open: Connected[] = [];
const freshCache = () => join(t.dir, `cache${n++}`);

/** A font fetch serving `body` that records every call. */
function fontFetch(body: Uint8Array | (() => Response) = FACE) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      typeof body === "function" ? body() : new Response(new Uint8Array(body)),
    );
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function server(cacheDir: string, fontFetchImpl: typeof fetch) {
  const pdfPath = join(t.dir, `form${n++}.pdf`);
  writeFileSync(pdfPath, await pdfFor(render));
  const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
  const clock = virtualClock();
  const c = await connect({
    env: env(cacheDir),
    fetchImpl: mock.fetch,
    fontFetchImpl,
    jpFontUrl: FONT_URL,
    ...clock,
  });
  open.push(c);
  expect((await c.call("analyze_form", { path: pdfPath })).data.status).toBe("done");
  return { c, pdfPath };
}

function pdftotext(file: string): string {
  return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(
    /\s+/g,
    " ",
  );
}

function seedFace(cacheDir: string) {
  mkdirSync(join(cacheDir, "fonts"), { recursive: true });
  writeFileSync(jpFontPath(cacheDir), FACE);
}

const cacheFontFiles = (cacheDir: string) =>
  existsSync(join(cacheDir, "fonts")) ? readdirSync(join(cacheDir, "fonts")) : [];

beforeEach(() => {
  t = tmp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of open.splice(0)) await c.close();
  t.cleanup();
});

describe.skipIf(!HAS_FACE)("fill_form prints Japanese", () => {
  it("stamps both strings (pdftotext) with a glyph-complete subset, fetching the face once", async () => {
    const cacheDir = freshCache();
    const font = fontFetch();
    const { c, pdfPath } = await server(cacheDir, font.f);
    const out = join(t.dir, "out.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { [cityId]: ADDRESS, [nameId]: NAME },
      output_path: out,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ filled: 2 });
    expect(font.calls).toHaveLength(1);

    const text = pdftotext(out);
    expect(text).toContain(ADDRESS);
    expect(text).toContain(NAME);

    // Every glyph of the embedded JP subset decodes to a real outline.
    const doc = await PDFDocument.load(readFileSync(out));
    let checked = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (!obj.get(PDFName.of("FontName"))?.toString().includes("NotoSansJP")) continue;
      const file = doc.context.lookup(obj.get(PDFName.of("FontFile2")));
      if (!(file instanceof PDFRawStream)) continue;
      const kit = fontkit.create(Buffer.from(decodePDFRawStream(file).decode()));
      for (let gid = 1; gid < kit.numGlyphs; gid++) {
        const g = kit.getGlyph(gid);
        expect(g.path.toSVG()).not.toBe("");
        expect(Math.abs(g.bbox.maxY)).toBeLessThan(2 * kit.unitsPerEm);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(14);
    expect(statSync(out).size).toBeLessThan(500_000);
  });

  it("preview_page renders a non-empty PNG for a Japanese page", async () => {
    const font = fontFetch();
    const { c, pdfPath } = await server(freshCache(), font.f);
    const r = await c.client.callTool(
      {
        name: "preview_page",
        arguments: { path: pdfPath, page: 1, values: { [nameId]: NAME }, dpi: 72 },
      },
      undefined,
      { timeout: 120_000 },
    );
    expect(r.isError).not.toBe(true);
    const img = (r.content as { type: string; data?: string }[])[0];
    expect(img.type).toBe("image");
    const png = Buffer.from(img.data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeGreaterThan(1000);
    expect(font.calls).toHaveLength(1);
  });
});

describe.skipIf(!HAS_FACE)("fetch and cache", () => {
  it("downloads once, caches 0600, and later fills (and a new cache copy) fetch nothing", async () => {
    const cacheDir = freshCache();
    const font = fontFetch();
    const { c, pdfPath } = await server(cacheDir, font.f);
    const fill = (name: string, v: string) =>
      c.call("fill_form", {
        path: pdfPath,
        values: { [nameId]: v },
        output_path: join(t.dir, name),
      });
    expect((await fill("a.pdf", NAME)).isError).toBe(false);
    expect(font.calls).toHaveLength(1);
    expect(font.calls[0].url).toBe(FONT_URL);

    const p = jpFontPath(cacheDir);
    expect(readdirSync(join(cacheDir, "fonts"))).toEqual([JP_FONT_FILE]);
    expect(Buffer.from(readFileSync(p)).equals(Buffer.from(FACE))).toBe(true);
    if (!IS_WIN) {
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(join(cacheDir, "fonts")).mode & 0o777).toBe(0o700);
    }

    expect((await fill("b.pdf", "田中 Hanako")).isError).toBe(false);
    expect(font.calls).toHaveLength(1);

    // A "new process": another cache dir (empty memo) holding the cached file.
    const second = freshCache();
    seedFace(second);
    const font2 = fontFetch();
    const { c: c2, pdfPath: pdf2 } = await server(second, font2.f);
    const r = await c2.call("fill_form", {
      path: pdf2,
      values: { [nameId]: NAME },
      output_path: join(t.dir, "c.pdf"),
    });
    expect(r.isError).toBe(false);
    expect(font2.calls).toHaveLength(0);
    expect(pdftotext(join(t.dir, "c.pdf"))).toContain(NAME);
  });

  it("an unwritable cache dir keeps the verified bytes for the process", async () => {
    const cacheDir = freshCache();
    // A file where fonts/ should be: mkdir fails on every platform and user.
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "fonts"), "not a directory");
    const font = fontFetch();
    const a = await ensureJpFace({ cacheDir, fetchImpl: font.f, url: FONT_URL });
    const b = await ensureJpFace({ cacheDir, fetchImpl: font.f, url: FONT_URL });
    expect(a.byteLength).toBe(FACE.byteLength);
    expect(b).toBe(a);
    expect(font.calls).toHaveLength(1);
  });

  it("replaces a corrupted cached file with a refetch", async () => {
    const cacheDir = freshCache();
    mkdirSync(join(cacheDir, "fonts"), { recursive: true });
    writeFileSync(jpFontPath(cacheDir), "garbage");
    const font = fontFetch();
    const face = await ensureJpFace({ cacheDir, fetchImpl: font.f, url: FONT_URL });
    expect(face.byteLength).toBe(FACE.byteLength);
    expect(font.calls).toHaveLength(1);
    expect(Buffer.from(readFileSync(jpFontPath(cacheDir))).equals(Buffer.from(FACE))).toBe(true);
  });
});

describe.skipIf(!HAS_FACE)(
  "failures refuse with unsupported_script and leave no font behind",
  () => {
    const big = (bytes: number, headers?: Record<string, string>) => () =>
      new Response(new Uint8Array(bytes), { headers });
    const cases: [string, string, () => Response | Promise<Response>][] = [
      ["network", "network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["http_status", "HTTP 404", () => new Response("nope", { status: 404 })],
      ["hash_mismatch", "pinned checksum", big(FACE.byteLength)],
      ["hash_mismatch", "pinned checksum", big(1000)],
      ["too_large", "larger than expected", big(FACE.byteLength + 1)],
      [
        "http_status",
        "HTTP",
        () => {
          const r = new Response(new Uint8Array(FACE));
          Object.defineProperty(r, "redirected", { value: true });
          Object.defineProperty(r, "url", { value: "https://evil.example/f.ttf" });
          return r;
        },
      ],
      ["hash_mismatch", "pinned checksum", big(10, { "content-length": "10" })],
      [
        "too_large",
        "larger than expected",
        big(10, { "content-length": String(20 * 1024 * 1024) }),
      ],
    ];
    it.each(cases)("%s (%s)", async (reason, phrase, make) => {
      const cacheDir = freshCache();
      const f = vi.fn(() => Promise.resolve(make())) as unknown as typeof fetch;
      const { c, pdfPath } = await server(cacheDir, f);
      const out = join(t.dir, "out.pdf");
      const r = await c.call("fill_form", {
        path: pdfPath,
        values: { [nameId]: NAME },
        output_path: out,
      });
      expect(r.isError).toBe(true);
      const err = r.data.error as { code: string; hint: string; ids: string[]; reason: string };
      expect(err).toMatchObject({ code: "unsupported_script", ids: [nameId], reason });
      expect(err.hint).toContain(phrase);
      expect(err.hint).toContain(jpFontPath(cacheDir));
      expect(existsSync(out)).toBe(false);
      expect(cacheFontFiles(cacheDir)).toEqual([]);
      // A retry is allowed (the failure was not memoized).
      expect(f).toHaveBeenCalledTimes(1);
      await c.call("fill_form", { path: pdfPath, values: { [nameId]: NAME }, output_path: out });
      expect(f).toHaveBeenCalledTimes(2);
    });

    it("times out (a download that never ends)", async () => {
      const cacheDir = freshCache();
      const hang = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch;
      const err = (await ensureJpFace({
        cacheDir,
        fetchImpl: hang,
        url: FONT_URL,
        timeoutMs: 30,
      }).catch((e: unknown) => e)) as JpFontError;
      expect(err.reason).toBe("timeout");
      expect(cacheFontFiles(cacheDir)).toEqual([]);
    });

    it("stampAndWrite without a jpFace refuses (no reason in details)", async () => {
      const { render: r } = fixture("canonical");
      const err: unknown = await stampAndWrite({
        pdfBytes: await pdfFor(r),
        render: r,
        agentInput: { "f-text": NAME },
        fonts: loadFonts(),
        branding: null,
        logoBytes: null,
        outputAbs: join(t.dir, "o.pdf"),
        overwrite: false,
        cache: new Cache(freshCache()),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err).toMatchObject({ code: "unsupported_script", details: { ids: ["f-text"] } });
    });
  },
);

describe("Latin-only fills", () => {
  it("never fetch the face, and match a fill with no jpFace byte for byte", async () => {
    const font = fontFetch();
    const cache = new Cache(freshCache());
    const { render: r } = fixture("canonical");
    const pdfBytes = await pdfFor(r);
    const base = {
      pdfBytes,
      render: r,
      agentInput: { "f-text": "Taro Yamada", "f-t1": "Zürich" },
      fonts: loadFonts(),
      branding: null,
      logoBytes: null,
      overwrite: false,
      cache,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    try {
      const a = join(t.dir, "a.pdf");
      const b = join(t.dir, "b.pdf");
      await stampAndWrite({
        ...base,
        outputAbs: a,
        jpFace: {
          load: () => ensureJpFace({ cacheDir: cache.root, fetchImpl: font.f, url: FONT_URL }),
          path: jpFontPath(cache.root),
        },
      });
      await stampAndWrite({ ...base, outputAbs: b });
      expect(Buffer.from(readFileSync(a)).equals(Buffer.from(readFileSync(b)))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(font.calls).toHaveLength(0);
    expect(cacheFontFiles(cache.root)).toEqual([]);
  });
});
