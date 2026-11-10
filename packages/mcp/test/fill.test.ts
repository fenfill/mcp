import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { degrees, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stampPdf } from "@/app/t/[template_id]/fillCore";
import { extractStampedText } from "@/e2e/helpers/pdfText";

import { Cache, sha256Hex } from "../src/cache.js";
import { resolveOutputPath, writeOutputAtomic } from "../src/fill.js";
import { loadFonts, toArrayBuffer } from "../src/fonts.js";
import { pageText, renderPage } from "../src/render.js";
import {
  apiError,
  connect,
  type Connected,
  env,
  fixture,
  json,
  MockApi,
  pdfFor,
  pngBytes,
  tmp,
  virtualClock,
} from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const TPL = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";
const IS_WIN = process.platform === "win32";
const LOGO = pngBytes(96, 32);

let t: ReturnType<typeof tmp>;
let cacheDir: string;
const open: Connected[] = [];
const { render, agent } = fixture("ungrouped_fields");
const nameId = agent.fields.find((e) => e.label === "Full name")!.id;
const agreeId = agent.fields.find((e) => e.type === "checkbox")!.id;

/** A test key (ff_test_): local fills made with it carry the TEST mark. */
const TEST_KEY = `ff_test_${"t".repeat(43)}`;
/** The mark's exact text (U+00B7 middle dot), as the server's export draws it. */
const MARK = "TEST \u00b7 fenfill test key";

async function server(mock: MockApi | null, clock = virtualClock(), key?: string) {
  const c = await connect({
    env: mock
      ? env(cacheDir, key ? { FENFILL_API_KEY: key } : {})
      : { FENFILL_CACHE_DIR: cacheDir },
    fetchImpl: mock?.fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  open.push(c);
  return c;
}

/** An analyzed form, by a server configured with `key` (default: the helpers'
 *  live key). `offline()` arms the server's INJECTED fetch to throw and counts
 *  every call made through it from then on. */
async function analyzed(key?: string): Promise<{
  pdfPath: string;
  c: Connected;
  offline: () => { calls: () => number };
}> {
  const pdfPath = join(t.dir, "form.pdf");
  writeFileSync(pdfPath, await pdfFor(render));
  const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
  let armed = false;
  let calls = 0;
  const guarded = ((...a: Parameters<typeof fetch>) => {
    if (armed) {
      calls++;
      throw new Error("fill_form touched the injected fetch");
    }
    return mock.fetch(...a);
  }) as typeof fetch;
  const clock = virtualClock();
  const c = await connect({
    env: env(cacheDir, key ? { FENFILL_API_KEY: key } : {}),
    fetchImpl: guarded,
    ...clock,
  });
  open.push(c);
  expect((await c.call("analyze_form", { path: pdfPath })).data.status).toBe("done");
  return {
    pdfPath,
    c,
    offline: () => {
      armed = true;
      return { calls: () => calls };
    },
  };
}

/** Each page's printed text as PDFium reads it, one space wherever it skipped whitespace. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const n = (await PDFDocument.load(bytes)).getPageCount();
  const out: string[] = [];
  for (let p = 1; p <= n; p++) {
    const { glyphs } = await pageText(bytes, p);
    out.push(
      glyphs.map((g, k) => (k > 0 && g.i > glyphs[k - 1].i + 1 ? " " : "") + g.char).join(""),
    );
  }
  return out;
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

/** The middle of the TEST mark's ink on a page as rendered (rotated and
 *  cropped as shown): the bounding box of its reddish pixels, in fractions of
 *  the page (the server's test picks the same pixels); null when there are none. */
async function markInk(bytes: Uint8Array, page: number): Promise<{ x: number; y: number } | null> {
  const r = await renderPage(bytes, page, 36);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4;
      if (r.rgba[i + 1] < 245 && r.rgba[i] > r.rgba[i + 1] + 10) {
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
  }
  if (x1 < 0) return null;
  return { x: (x0 + x1 + 1) / 2 / r.width, y: (y0 + y1 + 1) / 2 / r.height };
}

async function infoHas(bytes: Uint8Array, key: string): Promise<boolean> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof PDFDict && info.has(PDFName.of(key));
}

beforeEach(() => {
  t = tmp();
  cacheDir = join(t.dir, "cache");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const c of open.splice(0)) await c.close();
  t.cleanup();
});

describe("output path rules", () => {
  const input = () => join(t.dir, "in.pdf");
  beforeEach(() => writeFileSync(input(), "%PDF-1.7\n"));
  const opts = (o: Partial<{ overwrite: boolean }> = {}) => ({
    inputAbs: input(),
    overwrite: o.overwrite ?? false,
    cacheRoot: cacheDir,
  });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return (e as { code: string }).code;
    }
  };

  it("needs an absolute (or ~) path ending in .pdf, in an existing folder", async () => {
    expect(await code(resolveOutputPath("out.pdf", opts()))).toBe("invalid_path");
    expect(await code(resolveOutputPath("~other/out.pdf", opts()))).toBe("invalid_path");
    expect(await code(resolveOutputPath(join(t.dir, "out.txt"), opts()))).toBe(
      "invalid_output_path",
    );
    expect(await code(resolveOutputPath(join(t.dir, "nope", "out.pdf"), opts()))).toBe(
      "invalid_output_path",
    );
    expect(await resolveOutputPath(join(t.dir, "OUT.PDF"), opts())).toBe(join(t.dir, "OUT.PDF"));
    expect(await resolveOutputPath("~/fenfill-mcp-never-exists.pdf", opts())).toMatch(
      /fenfill-mcp-never-exists\.pdf$/,
    );
  });

  it("never overwrites the input, even through a symlink or with overwrite", async () => {
    expect(await code(resolveOutputPath(input(), opts({ overwrite: true })))).toBe(
      "invalid_output_path",
    );
    if (!IS_WIN) {
      const link = join(t.dir, "link.pdf");
      symlinkSync(input(), link);
      expect(await code(resolveOutputPath(link, opts({ overwrite: true })))).toBe(
        "invalid_output_path",
      );
    }
  });

  it("refuses an existing file unless overwrite", async () => {
    const other = join(t.dir, "other.pdf");
    writeFileSync(other, "x");
    expect(await code(resolveOutputPath(other, opts()))).toBe("output_exists");
    expect(await resolveOutputPath(other, opts({ overwrite: true }))).toBe(other);
  });

  it("never clobbers a file that appears after the check (no overwrite)", async () => {
    const late = join(t.dir, "late.pdf");
    const checked = await resolveOutputPath(late, opts());
    writeFileSync(late, "someone else's");
    expect(await code(writeOutputAtomic(checked, new Uint8Array([1, 2, 3]), false))).toBe(
      "output_exists",
    );
    expect(readFileSync(late, "utf8")).toBe("someone else's");
    expect(readdirSync(t.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await writeOutputAtomic(checked, new Uint8Array([1, 2, 3]), true);
    expect([...readFileSync(late)]).toEqual([1, 2, 3]);
  });

  it("refuses a path inside the cache", async () => {
    mkdirSync(join(cacheDir, "templates"), { recursive: true });
    expect(await code(resolveOutputPath(join(cacheDir, "templates", "x.pdf"), opts()))).toBe(
      "invalid_output_path",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "compares case-insensitively on a case-insensitive FS",
    async () => {
      expect(await code(resolveOutputPath(join(t.dir, "IN.pdf"), opts({ overwrite: true })))).toBe(
        "invalid_output_path",
      );
    },
  );
});

describe("fill_form", () => {
  it("stamps locally with no network at all, tags the output and registers it", async () => {
    const { pdfPath, c, offline } = await analyzed();
    const injected = offline();

    const fetchSpy = vi.fn(() => {
      throw new Error("fill_form touched fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("fill_form opened a socket");
    });

    const out = join(t.dir, "out.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada Lovelace", [agreeId]: true, "no-such-id": "x" },
      output_path: out,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ output_path: out, filled: 2 });
    expect((r.data.skipped as { id: string }[]).map((s) => s.id)).toEqual(["no-such-id"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(injected.calls()).toBe(0);

    const bytes = new Uint8Array(readFileSync(out));
    expect((await extractStampedText(bytes, 0)).toLowerCase()).toContain("ada lovelace");
    expect(await infoHas(bytes, "FenfillMcpOutput")).toBe(true);
    expect(await new Cache(cacheDir).isRegisteredOutput(sha256Hex(bytes))).toBe(true);
    // No temp file left behind.
    expect(readdirSync(t.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (!IS_WIN) expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("works with no API key configured", async () => {
    const { pdfPath } = await analyzed();
    const offline = await server(null);
    const r = await offline.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Grace" },
      output_path: join(t.dir, "o2.pdf"),
    });
    expect(r.data).toMatchObject({ filled: 1 });
  });

  it("asks for analyze_form on a cache miss", async () => {
    const p = join(t.dir, "fresh.pdf");
    writeFileSync(p, await pdfFor(render, "different bytes"));
    const r = await (
      await server(null)
    ).call("fill_form", {
      path: p,
      values: {},
      output_path: join(t.dir, "o.pdf"),
    });
    expect(r.data.error).toMatchObject({ code: "not_analyzed" });
  });

  it("refuses to overwrite without overwrite=true", async () => {
    const { pdfPath, c } = await analyzed();
    const out = join(t.dir, "exists.pdf");
    writeFileSync(out, "old");
    const r = await c.call("fill_form", { path: pdfPath, values: {}, output_path: out });
    expect(r.data.error).toMatchObject({ code: "output_exists" });
    expect(readFileSync(out, "utf8")).toBe("old");
    const ok = await c.call("fill_form", {
      path: pdfPath,
      values: {},
      output_path: out,
      overwrite: true,
    });
    expect(ok.isError).toBe(false);
  });

  it("check_pdf writes an outlined check copy beside the output, offline", async () => {
    const { pdfPath, c, offline } = await analyzed();
    const injected = offline();
    const out = join(t.dir, "filled.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada Lovelace" },
      output_path: out,
      check_pdf: true,
    });
    expect(r.isError).toBe(false);
    const check = join(t.dir, "filled.check.pdf");
    expect(r.data).toMatchObject({ output_path: out, check_path: check, filled: 1 });
    expect(injected.calls()).toBe(0);
    const bytes = new Uint8Array(readFileSync(check));
    // The check copy holds the answers too: tagged and registered like the output.
    expect((await extractStampedText(bytes, 0)).toLowerCase()).toContain("ada lovelace");
    expect(await infoHas(bytes, "FenfillMcpOutput")).toBe(true);
    expect(await new Cache(cacheDir).isRegisteredOutput(sha256Hex(bytes))).toBe(true);
    if (!IS_WIN) expect(statSync(check).mode & 0o777).toBe(0o600);

    // Without check_pdf no copy is written; an existing copy needs overwrite.
    const again = await c.call("fill_form", {
      path: pdfPath,
      values: {},
      output_path: join(t.dir, "other.pdf"),
    });
    expect(again.data).not.toHaveProperty("check_path");
    expect(readdirSync(t.dir)).not.toContain("other.check.pdf");
    writeFileSync(join(t.dir, "x3.check.pdf"), "old");
    const exists = await c.call("fill_form", {
      path: pdfPath,
      values: {},
      output_path: join(t.dir, "x3.pdf"),
      check_pdf: true,
    });
    expect(exists.data.error).toMatchObject({ code: "output_exists" });
    expect(readdirSync(t.dir)).not.toContain("x3.pdf");
  });

  it("a test key (ff_test_) puts the TEST mark on every page, and on the check copy, offline", async () => {
    const { pdfPath, c, offline } = await analyzed(TEST_KEY);
    const injected = offline();
    const out = join(t.dir, "test.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada Lovelace" },
      output_path: out,
      check_pdf: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ output_path: out, filled: 1 });
    expect(injected.calls()).toBe(0);
    const bytes = new Uint8Array(readFileSync(out));
    const texts = await pageTexts(bytes);
    expect(texts.length).toBeGreaterThan(1);
    for (const [i, text] of texts.entries()) {
      expect(count(text, MARK), `page ${String(i + 1)}`).toBe(1);
      // Centred on the page, as the server's export draws it (3%).
      const ink = await markInk(bytes, i + 1);
      expect(ink, `page ${String(i + 1)}`).not.toBeNull();
      expect(Math.abs(ink!.x - 0.5)).toBeLessThan(0.03);
      expect(Math.abs(ink!.y - 0.5)).toBeLessThan(0.03);
    }
    // The value is stamped as without the key.
    expect((await extractStampedText(bytes, 0)).toLowerCase()).toContain("ada lovelace");
    // The check copy is built from the marked output.
    const check = await pageTexts(new Uint8Array(readFileSync(r.data.check_path as string)));
    expect(check).toHaveLength(texts.length);
    for (const text of check) expect(count(text, MARK)).toBe(1);
  });

  it("a live key (ff_live_) leaves the output unmarked", async () => {
    const { pdfPath, c } = await analyzed();
    const out = join(t.dir, "live.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada Lovelace" },
      output_path: out,
    });
    expect(r.isError).toBe(false);
    const bytes = new Uint8Array(readFileSync(out));
    const texts = await pageTexts(bytes);
    for (const [i, text] of texts.entries()) {
      expect(text).not.toContain("test key");
      expect(await markInk(bytes, i + 1)).toBeNull();
    }
  });

  it.skipIf(IS_WIN)("keeps the cache private (0700 dirs, 0600 files)", async () => {
    await analyzed();
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [join(d, e.name), ...walk(join(d, e.name))] : [join(d, e.name)],
      );
    const all = walk(cacheDir);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      const st = statSync(p);
      expect(st.mode & 0o777, p).toBe(st.isDirectory() ? 0o700 : 0o600);
    }
  });
});

describe("fill_template", () => {
  function templateApi(opts: { logo: boolean; watermark?: boolean; logo404?: boolean }) {
    const pdfP = pdfFor(render);
    return new MockApi()
      .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
        json(200, { ...agent, template_id: TPL, name: "Tax form", render }),
      )
      .on("GET", /^\/v1\/account$/, () =>
        json(200, {
          workspace_id: "ws-1",
          tier: opts.logo ? "pro" : "solo",
          scans_remaining: 10,
          max_pages: 100,
          max_pages_per_job: 60,
          max_file_mb: 50,
          branding: { logo: opts.logo, watermark: opts.watermark ?? false },
        }),
      )
      .on(
        "GET",
        new RegExp(`^/v1/templates/${TPL}/pdf$`),
        async () => new Response(new Uint8Array(await pdfP)),
      )
      .on("GET", /^\/v1\/account\/logo$/, () =>
        opts.logo404 ? apiError(404, "not_found") : new Response(LOGO),
      );
  }

  async function imageCount(path: string): Promise<number> {
    const doc = await PDFDocument.load(readFileSync(path));
    const x = doc.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
    return x instanceof PDFDict ? x.keys().length : 0;
  }

  it("stamps the workspace logo when the plan has one, and caches blank + logo for 1 h", async () => {
    const mock = templateApi({ logo: true });
    const clock = virtualClock();
    const c = await server(mock, clock);
    const out = join(t.dir, "tpl.pdf");
    const r = await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "Ada" },
      output_path: out,
    });
    expect(r.data).toMatchObject({ template_id: TPL, output_path: out, filled: 1 });
    expect(
      (await extractStampedText(new Uint8Array(readFileSync(out)), 0)).toLowerCase(),
    ).toContain("ada");
    expect(await imageCount(out)).toBeGreaterThan(0);

    await c.call("fill_template", {
      template_id: TPL,
      values: {},
      output_path: join(t.dir, "b.pdf"),
    });
    expect(mock.count("GET", /\/pdf$/)).toBe(1);
    expect(mock.count("GET", /\/account\/logo$/)).toBe(1);
    // The render schema and the account are always re-fetched.
    expect(mock.count("GET", new RegExp(`/templates/${TPL}$`))).toBe(2);

    clock.advance(61 * 60 * 1000);
    await c.call("fill_template", {
      template_id: TPL,
      values: {},
      output_path: join(t.dir, "c.pdf"),
    });
    expect(mock.count("GET", /\/pdf$/)).toBe(2);
  });

  it("stamps clean when the plan has no logo (never asks for one)", async () => {
    const mock = templateApi({ logo: false });
    const c = await server(mock);
    const out = join(t.dir, "clean.pdf");
    await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "Ada" },
      output_path: out,
    });
    expect(await imageCount(out)).toBe(0);
    expect(mock.count("GET", /\/account\/logo$/)).toBe(0);
  });

  it("a missing logo (404) stamps clean without any logo fetch fallback", async () => {
    const mock = templateApi({ logo: true, logo404: true });
    const c = await server(mock);
    const out = join(t.dir, "nologo.pdf");
    const r = await c.call("fill_template", { template_id: TPL, values: {}, output_path: out });
    expect(r.isError).toBe(false);
    expect(await imageCount(out)).toBe(0);
    // Exactly one logo request: the API's, never a stampPdf fetch of a URL.
    expect(mock.calls.filter((x) => x.url.includes("logo"))).toHaveLength(1);
  });

  it("a test key marks every page and keeps the Free-tier stamp", async () => {
    const mock = templateApi({ logo: false, watermark: true });
    const c = await server(mock, virtualClock(), TEST_KEY);
    const out = join(t.dir, "tpl-test.pdf");
    const r = await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "Ada" },
      output_path: out,
      check_pdf: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ template_id: TPL, output_path: out, filled: 1 });
    const texts = await pageTexts(new Uint8Array(readFileSync(out)));
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(count(text, MARK)).toBe(1);
      expect(text).toContain("Made with fenfill.com");
    }
    const check = await pageTexts(new Uint8Array(readFileSync(r.data.check_path as string)));
    for (const text of check) expect(count(text, MARK)).toBe(1);
  });

  it("a live key keeps the Free-tier stamp without the mark", async () => {
    const mock = templateApi({ logo: false, watermark: true });
    const c = await server(mock);
    const out = join(t.dir, "tpl-live.pdf");
    const r = await c.call("fill_template", { template_id: TPL, values: {}, output_path: out });
    expect(r.isError).toBe(false);
    for (const text of await pageTexts(new Uint8Array(readFileSync(out)))) {
      expect(text).toContain("Made with fenfill.com");
      expect(text).not.toContain("test key");
    }
  });

  it("rejects a malformed template id before any request", async () => {
    const mock = templateApi({ logo: false });
    const r = await (
      await server(mock)
    ).call("fill_template", {
      template_id: "../../etc",
      values: {},
      output_path: join(t.dir, "x.pdf"),
    });
    expect(r.isError).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("the TEST mark on rotated and cropped pages (stampPdf testMark, PDFium raster)", () => {
  // (rotation, page size, CropBox): the server's test pages for its export.
  const PAGES: [number, [number, number], [number, number, number, number] | null][] = [
    [0, [612, 792], null],
    [90, [612, 792], null],
    [180, [595, 842], null],
    [270, [612, 792], [20, 50, 560, 680]],
    [90, [1500, 400], null],
    [0, [612, 792], [36, 48, 540, 700]],
  ];

  it("reads once per page, its ink centred on the page as shown", async () => {
    const doc = await PDFDocument.create();
    for (const [rotate, size, crop] of PAGES) {
      const page = doc.addPage(size);
      page.setRotation(degrees(rotate));
      if (crop) page.setCropBox(...crop);
    }
    const out = await stampPdf({
      pdfBytes: toArrayBuffer(await doc.save()),
      marksByPage: new Map(),
      fonts: loadFonts(),
      testMark: true,
    });
    const texts = await pageTexts(out);
    expect(texts).toHaveLength(PAGES.length);
    for (const [i, text] of texts.entries()) {
      const at = `page ${String(i + 1)} (rotate ${String(PAGES[i][0])})`;
      expect(count(text, MARK), at).toBe(1);
      const ink = await markInk(out, i + 1);
      expect(ink, at).not.toBeNull();
      expect(Math.abs(ink!.x - 0.5), at).toBeLessThan(0.03);
      expect(Math.abs(ink!.y - 0.5), at).toBeLessThan(0.03);
    }
  });
});
