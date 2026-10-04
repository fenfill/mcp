// Local filling: input/output path rules, the signature-image loader, and the
// stamp → atomic write → output-registry step shared by fill_form and
// fill_template.
//
// PRIVACY: agent-provided fill values live only in `agentInput` here.
// They go to the stamping core and nowhere else: never to a request, a log line,
// or the cache. The filled PDF is written only to the path the agent chose,
// which may not lie inside the cache directory.

import { randomBytes } from "node:crypto";
import { promises as fsp, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { type AgentSkip, fillAgentPdf, MCP_OUTPUT_TAG } from "@/app/t/[template_id]/fillCore";

import { type Cache, sha256Hex } from "./cache.js";
import { expandHome } from "./config.js";
import { ToolError } from "./errors.js";
import type { Fonts } from "./fonts.js";
import { toArrayBuffer } from "./fonts.js";
import type { RenderSchema } from "./types.js";
import { VERSION } from "./version.js";

const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IS_WIN = process.platform === "win32";

/** Only the Info key matters (analyze_form refuses a PDF carrying it). */
export const OUTPUT_TAGS: Record<string, string> = { [MCP_OUTPUT_TAG]: `fenfill-mcp/${VERSION}` };

/** Sentinel logo URL: set only alongside real logo bytes, so stampPdf never fetches. */
export const LOGO_SENTINEL = "fenfill-mcp:logo";

function absPath(p: string, what: string): string {
  const abs = expandHome(p.trim());
  if (!isAbsolute(abs)) {
    throw new ToolError("invalid_path", `${what} must be an absolute path (or start with ~/).`, {
      hint: "Pass the full path, e.g. /Users/me/forms/form.pdf or ~/forms/form.pdf.",
    });
  }
  return resolve(abs);
}

/** Read a PDF the agent pointed at. */
export async function readInputPdf(path: string): Promise<{ abs: string; bytes: Uint8Array }> {
  const abs = absPath(path, "path");
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new ToolError("file_not_found", "No file at that path.", {
      hint: "Check the path (it must be absolute or start with ~/).",
    });
  }
  if (!st.isFile()) throw new ToolError("not_a_file", "That path is not a file.");
  if (st.size > MAX_INPUT_BYTES) throw new ToolError("file_too_large", "The file is too large.");
  const bytes = new Uint8Array(await fsp.readFile(abs));
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) {
    throw new ToolError("not_pdf", "The file is not a PDF.", { hint: "Pass a PDF file." });
  }
  return { abs, bytes };
}

function swapCase(s: string): string {
  let out = "";
  for (const c of s) {
    const u = c.toUpperCase();
    out += u === c ? c.toLowerCase() : u;
  }
  return out;
}

/** Is the filesystem holding `dir` case-insensitive? Probed, with a platform fallback. */
async function caseInsensitiveAt(dir: string): Promise<boolean> {
  const swapped = swapCase(dir);
  if (swapped !== dir) {
    try {
      const [a, b] = await Promise.all([fsp.stat(dir), fsp.stat(swapped)]);
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  }
  return process.platform === "darwin" || IS_WIN;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate `output_path` and return it absolute. Rules: absolute or `~`; ends
 * in .pdf; its folder exists; not the input file (same dev/ino when it exists,
 * else the real folder + name, case-folded on case-insensitive filesystems);
 * not inside the cache; an existing file only with `overwrite`.
 */
export async function resolveOutputPath(
  outputPath: string,
  opts: { inputAbs: string | null; overwrite: boolean; cacheRoot: string },
): Promise<string> {
  const out = absPath(outputPath, "output_path");
  if (!out.toLowerCase().endsWith(".pdf")) {
    throw new ToolError("invalid_output_path", "output_path must end in .pdf.");
  }
  const dir = dirname(out);
  let realDir: string;
  try {
    realDir = await fsp.realpath(dir);
    if (!(await fsp.stat(realDir)).isDirectory()) throw new Error("not a dir");
  } catch {
    throw new ToolError("invalid_output_path", "The output folder doesn't exist.", {
      hint: "Create the folder first, or pick an existing one.",
    });
  }
  const realOut = join(realDir, basename(out));

  let realCache = resolve(opts.cacheRoot);
  try {
    realCache = await fsp.realpath(realCache);
  } catch {
    // the cache may not exist yet
  }
  const ci = await caseInsensitiveAt(realDir);
  const fold = (s: string) => (ci ? s.toLowerCase() : s);
  if (isInside(fold(realOut), fold(realCache))) {
    throw new ToolError("invalid_output_path", "output_path may not be inside the fenfill cache.", {
      hint: "Write the filled PDF somewhere else, e.g. ~/Documents.",
    });
  }

  let existing: Awaited<ReturnType<typeof fsp.stat>> | null = null;
  try {
    existing = await fsp.stat(out);
  } catch {
    existing = null;
  }

  if (opts.inputAbs) {
    const same = () =>
      new ToolError("invalid_output_path", "output_path is the input file.", {
        hint: "Write the filled PDF to a new file; the blank form stays untouched.",
      });
    if (existing) {
      const input = await fsp.stat(opts.inputAbs);
      if (existing.dev === input.dev && existing.ino === input.ino && input.ino !== 0) throw same();
    }
    let realIn = opts.inputAbs;
    try {
      realIn = await fsp.realpath(opts.inputAbs);
    } catch {
      // compare the plain path
    }
    if (fold(realOut) === fold(realIn)) throw same();
  }

  if (existing) {
    if (!existing.isFile()) {
      throw new ToolError("invalid_output_path", "output_path exists and is not a file.");
    }
    if (!opts.overwrite) {
      throw new ToolError("output_exists", "A file already exists at output_path.", {
        hint: "Pick a new file name, or pass overwrite=true to replace it.",
      });
    }
  }
  return out;
}

/**
 * Write via a temp file in the same folder, then move it into place: rename
 * (replacing) with `overwrite`, else a hard link, which fails instead of
 * clobbering a file that appeared since the path was checked. Filesystems
 * without hard links fall back to a re-check + rename.
 */
export async function writeOutputAtomic(
  out: string,
  pdf: Uint8Array,
  overwrite: boolean,
): Promise<void> {
  const tmp = join(dirname(out), `.${basename(out)}.${randomBytes(6).toString("hex")}.tmp`);
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  const exists = () =>
    new ToolError("output_exists", "A file already exists at output_path.", {
      hint: "Pick a new file name, or pass overwrite=true to replace it.",
    });
  try {
    fh = await fsp.open(tmp, "wx", 0o600);
    await fh.writeFile(pdf);
    await fh.sync();
    await fh.close();
    fh = null;
    if (overwrite) {
      await fsp.rename(tmp, out);
    } else {
      try {
        await fsp.link(tmp, out);
        await fsp.rm(tmp, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw exists();
        if (
          await fsp.stat(out).then(
            () => true,
            () => false,
          )
        )
          throw exists();
        await fsp.rename(tmp, out);
      }
    }
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    if (e instanceof ToolError) throw e;
    throw new ToolError("write_failed", "Couldn't write the output PDF.", {
      hint: "Check that the folder is writable.",
      details: { cause: (e as NodeJS.ErrnoException).code ?? null },
    });
  }
}

/** The core's signature loader: an absolute (or ~) path to a PNG/JPG, ≤ 5 MB. */
export function loadImage(p: string): Uint8Array {
  const abs = expandHome(p.trim());
  if (!isAbsolute(abs)) throw new Error("image_path must be an absolute path (or start with ~/).");
  const st = statSync(abs);
  if (!st.isFile()) throw new Error("image_path is not a file.");
  if (st.size > MAX_IMAGE_BYTES) throw new Error("The signature image is over 5 MB.");
  return new Uint8Array(readFileSync(abs));
}

/** A PDF that needs a user password to open (decryptPdf's refusal). */
export function isPasswordError(e: unknown): boolean {
  return e instanceof Error && /password/i.test(e.message);
}

export function passwordError(): ToolError {
  return new ToolError("pdf_password_required", "This PDF needs a password to open.", {
    hint: "Save a copy without the open password, then use that file.",
  });
}

/** The stamp-time backstop for a PDF whose author forbids filling (assertFillPermitted). */
export function isFillForbiddenError(e: unknown): boolean {
  return e instanceof Error && /doesn't allow it to be filled/i.test(e.message);
}

export function fillForbiddenError(): ToolError {
  return new ToolError("pdf_fill_forbidden", "The PDF's author forbids filling it in.", {
    hint: "fenfill can't fill this file; use a copy whose permissions allow form filling.",
  });
}

export interface StampArgs {
  pdfBytes: Uint8Array;
  render: RenderSchema;
  agentInput: Record<string, unknown>;
  fonts: Fonts;
  branding: { watermark: boolean; logoUrl: string | null } | null;
  logoBytes: ArrayBuffer | null;
  outputAbs: string;
  /** The agent allowed replacing an existing output_path. */
  overwrite: boolean;
  cache: Cache;
  /** Also write the check copy here (checkPathFor, already validated). */
  checkAbs?: string | null;
}

export interface StampResult {
  output_path: string;
  /** The check copy (check_pdf): every field box outlined and tagged. */
  check_path?: string;
  filled: number;
  skipped: AgentSkip[];
  warnings: string[];
}

/** `<output>.check.pdf` next to the output, under the same path rules. */
export async function checkPathFor(
  outputAbs: string,
  opts: { inputAbs: string | null; overwrite: boolean; cacheRoot: string },
): Promise<string> {
  return resolveOutputPath(outputAbs.replace(/\.pdf$/i, ".check.pdf"), opts);
}

export async function stampAndWrite(a: StampArgs): Promise<StampResult> {
  let res: Awaited<ReturnType<typeof fillAgentPdf>>;
  try {
    res = await fillAgentPdf({
      pdfBytes: toArrayBuffer(a.pdfBytes),
      render: a.render,
      input: a.agentInput,
      fonts: a.fonts,
      branding: a.branding,
      logoBytes: a.logoBytes,
      loadImage,
      infoTags: OUTPUT_TAGS,
      check: !!a.checkAbs,
    });
  } catch (e) {
    if (isPasswordError(e)) throw passwordError();
    if (isFillForbiddenError(e)) throw fillForbiddenError();
    throw e;
  }
  await writeOutputAtomic(a.outputAbs, res.pdf, a.overwrite);
  await a.cache.registerOutput(sha256Hex(res.pdf));
  let checkPath: string | undefined;
  if (a.checkAbs && res.checkPdf) {
    // Holds the answers too (it is the filled PDF, annotated): written only
    // beside the output, and registered so analyze_form refuses it.
    await writeOutputAtomic(a.checkAbs, res.checkPdf, a.overwrite);
    await a.cache.registerOutput(sha256Hex(res.checkPdf));
    checkPath = a.checkAbs;
  }
  return {
    output_path: a.outputAbs,
    ...(checkPath ? { check_path: checkPath } : {}),
    filled: res.filled,
    skipped: res.skipped,
    warnings: res.warnings,
  };
}
