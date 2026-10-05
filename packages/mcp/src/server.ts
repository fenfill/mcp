// The MCP server: twelve tools over /v1 plus local filling, previews and
// layout corrections.
//
// PRIVACY: fill values arrive as the `values` argument of fill_form /
// fill_template / preview_page and go only to the local stamping core
// (fill.ts, preview.ts) and the in-memory echo guard (echo.ts). Logs are
// stderr-only and carry the tool name, an error code and a duration — never an
// argument. fill_form and preview_page (on a file) never build the API client,
// so they never read the key and never open a socket. edit_template keeps its
// working copy on this machine; only save_template sends it (layout and the
// form's wording). The echo guard rejects an edit whose wording repeats an
// answer of this session before the copy is written; wording a copy got from
// an earlier process needs save_template's confirm_wording.

import { randomBytes } from "node:crypto";
import { setTimeout as sleepTimer } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { analyzeForm, type InFlight, LIVE_OWNERS } from "./analyze.js";
import { FenfillApi } from "./api.js";
import {
  type ApiIdentity,
  Cache,
  editKeyForFile,
  editKeyForTemplate,
  keyFingerprint,
  sameAccount,
  sha256Hex,
  type WorkingCopy,
} from "./cache.js";
import { agentEntries, normalizeSchema } from "@/app/t/[template_id]/fillCore";

import { compactView } from "./compact.js";
import {
  type ApiConfig,
  apiConfigFromEnv,
  cacheDirFromEnv,
  type Env,
  waitSecondsFromEnv,
} from "./config.js";
import { asToolError, ToolError } from "./errors.js";
import {
  checkPathFor,
  LOGO_SENTINEL,
  readInputPdf,
  resolveOutputPath,
  stampAndWrite,
} from "./fill.js";
import { loadFonts, toArrayBuffer } from "./fonts.js";
import { log } from "./log.js";
import { EchoGuard } from "./echo.js";
import { applyOps, changedWording, MAX_OPS, type Snapper, wordingChanges } from "./edits.js";
import { mergeAnalyses, soleTemplateId } from "./merge.js";
import { parsePageSpec } from "./pages.js";
import { placementWarnings, stampedSizes } from "./placement.js";
import { legendChanges, legendPrints, legendRows, MAX_ZOOM, previewPage } from "./preview.js";
import { analyzedPagesOf, RERUN_KINDS, reanalyzeTemplate } from "./reanalyze.js";
import { DEFAULT_DPI, MAX_DPI } from "./render.js";
import { pageOfId, prepareSnapper, snapPages } from "./snap.js";
import { SWEEP_INTERVAL_MS, sweepCache } from "./sweep.js";
import type { Account, AgentSchema, RenderSchema, TemplateUpdated } from "./types.js";
import { schemaIssues } from "./validate.js";
import { VERSION } from "./version.js";

export interface ServerOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
  fontsDir?: string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface FenfillServer {
  server: McpServer;
  /** Stop polling, let in-flight analyze uploads record their job id, close. */
  shutdown: (graceMs?: number) => Promise<void>;
}

const TOOL_NAMES = [
  "analyze_form",
  "fill_form",
  "fill_template",
  "list_templates",
  "get_template",
  "create_recipient_link",
  "get_recipient_status",
  "get_account",
  "preview_page",
  "edit_template",
  "save_template",
  "reanalyze_template",
] as const;
export { TOOL_NAMES };

// What each value looks like. Text is stamped verbatim (a date asked for in a
// text box goes in that box's own format); a `date` field takes ISO
// (agentValues.ts coerceDate, as the browser stores it) and prints in the
// field's date_format (fillMarks.ts, every fill path).
const VALUE_SHAPES =
  'values maps field ids to: text/multiline = string, stamped exactly as given (a date in a text field goes in the format its label or placeholder asks, e.g. "mmddyyyy" → "10042026"); date = "YYYY-MM-DD", printed in the field\'s date_format (shown on the field, e.g. DD/MM/YYYY); comb = string, one character per cell; checkbox = boolean; radio = option id or label, or the bare option text ("No" for "Smoke? No"); multiselect = array of those; table = {cellId: value}; table_rows = [{columnId: value}, …]; signature = {"image_path": "/abs/sig.png"} (PNG or JPG). A signature with signing_requirement "external" is signed outside fenfill (on paper or by e-sign) and stays blank.';

const INSTRUCTIONS = [
  "fenfill turns blank PDF forms into fillable ones.",
  "Local file: analyze_form(path) returns the form's fields (the blank form is uploaded once; results are cached, repeat calls are free), then fill_form(path, values, output_path) fills it on this machine.",
  "Saved templates: list_templates → get_template → fill_template.",
  "preview_page shows a page with every field box outlined and tagged (rendered on this machine); edit_template fixes a misplaced, missing or mislabeled field locally; save_template keeps the fix in a saved template.",
  "A saved template's page that was never analyzed (get_template unanalyzed_pages) or came out badly: reanalyze_template re-runs fenfill on just those pages, from the PDF already stored with it.",
  "Fill values never leave this machine: they are not sent to fenfill or anywhere else.",
].join(" ");

const TEMPLATE_ID = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "a fenfill template id")
  .describe("Template id (from list_templates).");
const PAGES = z
  .string()
  .max(2000)
  .optional()
  .describe('1-based pages, e.g. "1-3,5". Omit for all.');
const VALUES = z.record(z.string(), z.unknown()).describe("Field id → value (see description).");
const OUTPUT_PATH = z
  .string()
  .min(1)
  .max(4096)
  .describe("Absolute path (or ~/…) of the new .pdf to write.");
const OVERWRITE = z.boolean().optional().describe("Replace output_path if it exists.");
const TARGET_PATH = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    "The blank PDF you analyzed with analyze_form (absolute or ~/…). Pass this or template_id.",
  );
const TARGET_TEMPLATE = TEMPLATE_ID.optional().describe(
  "A saved template's id. Pass this or path.",
);
const EDITED_NOTE =
  "Used your local edits (edit_template). save_template keeps them in a saved template; edit_template with discard: true drops them.";
const CHECK_PDF = z
  .boolean()
  .optional()
  .describe(
    "Also write <output>.check.pdf beside it: the filled PDF with every field box outlined (green filled, orange warning, red skipped, grey empty) and tagged with its id prefix. Open it to verify placement; it stays on this machine.",
  );

function ok(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** Exactly one of path / template_id. */
function oneTarget(a: { path?: string; template_id?: string }): void {
  if (!!a.path === !!a.template_id) {
    throw new ToolError("invalid_argument", "Pass either path or template_id (exactly one).", {
      hint: "path: the blank PDF you analyzed with analyze_form; template_id: a saved template.",
    });
  }
}

function fail(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: err.toJSON() }) }],
  };
}

/** A server-side validation item, with the field/group id its path points at. */
function withItemId(it: unknown, schema: RenderSchema): unknown {
  if (typeof it !== "object" || it === null) return it;
  const path = (it as { path?: unknown }).path;
  if (typeof path !== "string") return it;
  const m = /^(?:schema\.)?(fields|groups)\.(\d+)/.exec(path);
  if (!m) return it;
  const list = m[1] === "fields" ? schema.fields : schema.groups;
  const item = list[Number(m[2])];
  return item && typeof item.id === "string" ? { ...it, id: item.id } : it;
}

/** After a save, the cached analyses of that template show the saved layout. */
async function refreshSavedAnalyses(
  cache: Cache,
  templateId: string,
  render: RenderSchema,
  saved: TemplateUpdated,
  who: ApiIdentity | null,
): Promise<void> {
  // Only the edited forms' caches are touched: a template's analyses live
  // under the sha of its blank PDF.
  const roots = await cache.formShas();
  for (const sha of roots) {
    for (const e of await cache.listAnalyses(sha)) {
      if (e.template_id !== templateId || !sameAccount(e, who)) continue;
      const agent = saved.result && Array.isArray(saved.result.fields) ? saved.result : e.agent;
      await cache
        .saveAnalysis({
          ...e,
          render: { ...render, pages: e.render.pages },
          agent: { ...agent, template_id: templateId, updated_at: saved.updated_at },
        })
        .catch(() => undefined);
    }
  }
}

export function createFenfillServer(opts: ServerOptions = {}): FenfillServer {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    (async (ms: number, signal?: AbortSignal) => {
      await sleepTimer(ms, undefined, { signal });
    });
  const cache = new Cache(cacheDirFromEnv(env), now);
  const stop = new AbortController();
  const owner = randomBytes(8).toString("hex");
  LIVE_OWNERS.add(owner);
  // Stamped on every working copy this instance writes: only its own echo
  // guard has checked that wording.
  const writer = { pid: process.pid, started_at: new Date(now()).toISOString(), owner };
  const inFlight = new Map<string, InFlight>();
  const posts = new Set<Promise<unknown>>();

  let apiClient: FenfillApi | null = null;
  const api = (): FenfillApi => {
    apiClient ??= new FenfillApi(apiConfigFromEnv(env), { fetchImpl: opts.fetchImpl, now, sleep });
    return apiClient;
  };

  // The API + account the cache tags analyses and jobs with. The workspace id
  // is looked up once per key for the process lifetime; the key itself is
  // never stored, only a truncated hash of it.
  const workspaceByKey = new Map<string, string>();
  const identity = async (fetchWs: boolean): Promise<ApiIdentity | null> => {
    let cfg: ApiConfig;
    try {
      cfg = apiConfigFromEnv(env);
    } catch {
      return null;
    }
    const keySha = keyFingerprint(cfg.apiKey);
    if (fetchWs && !workspaceByKey.has(keySha)) {
      try {
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]);
        const { body } = await api().getJson<Account>("/account", { signal });
        if (typeof body.workspace_id === "string" && body.workspace_id) {
          workspaceByKey.set(keySha, body.workspace_id);
        }
      } catch {
        // best effort: the key hash still identifies the account
      }
    }
    return {
      api_origin: cfg.apiUrl,
      account: { workspace_id: workspaceByKey.get(keySha) ?? null, key_sha: keySha },
    };
  };

  // Cache hygiene in the background: at startup, then at most once a day.
  let lastSweep = -Infinity;
  const maybeSweep = () => {
    const t = now();
    if (t - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = t;
    void sweepCache(cache, t).catch(() => undefined);
  };
  maybeSweep();

  // Free-text answers seen this session, for save_template's echo guard.
  // In memory only (echo.ts).
  const echo = new EchoGuard();

  /** preview_page legend fingerprints by target + page, for legend: "changed" (this process only). */
  const lastLegend = new Map<string, Map<string, string>>();

  // ---- local working copies (edit_template) ----------------------------------------

  /** The analyzed form of a local blank PDF, and the edit key it uses. */
  const fileForm = async (path: string) => {
    const { abs, bytes } = await readInputPdf(path);
    const sha = sha256Hex(bytes);
    const merged = mergeAnalyses(await cache.listAnalyses(sha));
    if (!merged) {
      throw new ToolError("not_analyzed", "This PDF hasn't been analyzed on this machine yet.", {
        hint: "Run analyze_form on this file first.",
      });
    }
    // A file whose every analyzed page comes from ONE saved template of this
    // account edits that template's working copy (so save_template can keep it).
    const who = await identity(false);
    const templateId = soleTemplateId(merged, null, who);
    return { abs, bytes, sha, merged, templateId };
  };

  /** A template's working copy, if this account has one. */
  const templateEdits = async (templateId: string): Promise<WorkingCopy | null> => {
    const wc = await cache.readEdits(editKeyForTemplate(templateId));
    if (!wc) return null;
    return sameAccount(wc, await identity(false)) ? wc : null;
  };

  /**
   * The working copy a file's fill/preview uses: its template's when the file
   * is one saved template (never the file's own copy then: that one belongs to
   * an earlier unsaved analysis, with other ids), else its own.
   */
  const fileEdits = async (f: { sha: string; templateId: string | null }) =>
    f.templateId ? templateEdits(f.templateId) : cache.readEdits(editKeyForFile(f.sha));

  /** Drop the file copies (f-<sha>) of the PDFs analyzed as `templateId`
   *  (plus `sha`): once a template copy exists or is saved, they are stale. */
  const dropFileCopies = async (templateId: string, sha: string | null) => {
    const who = await identity(false);
    const shas = new Set<string>(sha ? [sha] : []);
    for (const s of await cache.formShas()) {
      const all = await cache.listAnalyses(s);
      if (all.some((e) => e.template_id === templateId && sameAccount(e, who))) shas.add(s);
    }
    for (const s of shas) await cache.deleteEdits(editKeyForFile(s)).catch(() => false);
  };

  const editsNote = async (sha: string, templateId: string | null) => {
    const wc = await fileEdits({ sha, templateId });
    return wc
      ? {
          local_edits:
            "This form has local edits (edit_template) that fill_form and preview_page use; the fields listed are fenfill's analysis without them. save_template keeps them; edit_template with discard: true drops them.",
        }
      : {};
  };

  /** A template's render + version from fenfill. */
  const fetchTemplate = async (templateId: string, signal: AbortSignal) => {
    const { body } = await api().getJson<AgentSchema & { render?: RenderSchema }>(
      `/templates/${encodeURIComponent(templateId)}?include=render`,
      { signal },
    );
    if (!body.render) {
      throw new ToolError("bad_response", "fenfill returned the template without its schema.", {
        hint: "Retry shortly.",
      });
    }
    return {
      render: body.render,
      updated_at: typeof body.updated_at === "string" ? body.updated_at : null,
    };
  };

  /** A saved template's blank PDF (1 h cache). */
  const templateBlank = async (templateId: string, signal: AbortSignal, deadline?: number) => {
    let blank = await cache.readBlank(templateId);
    if (!blank) {
      blank = await api().getBytes(`/templates/${encodeURIComponent(templateId)}/pdf`, {
        signal,
        deadline,
      });
      if (!blank) throw new ToolError("not_found", "The template's PDF is missing.");
      await cache.writeBlank(templateId, blank);
    }
    return blank;
  };

  const server = new McpServer(
    { name: "fenfill", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const run =
    <A>(name: string, fn: (args: A, extra: Extra, signal: AbortSignal) => Promise<unknown>) =>
    async (args: A, extra: Extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      maybeSweep();
      const signal = AbortSignal.any([extra.signal, stop.signal]);
      try {
        const result = await fn(args, extra, signal);
        log("info", "tool ok", { tool: name, ms: Date.now() - t0 });
        return ok(result);
      } catch (e) {
        const err = asToolError(e);
        log("warn", "tool failed", { tool: name, code: err.code, ms: Date.now() - t0 });
        return fail(err);
      }
    };

  // ---- analyze_form -----------------------------------------------------------------
  server.registerTool(
    "analyze_form",
    {
      title: "Analyze a blank PDF form",
      description:
        'Analyze a blank PDF form with fenfill and list its fillable fields (ids, types, labels). Uploads only the blank form. Costs one page scan per analyzed page unless cached or the PDF has native form fields (free; detect_extra_blanks adds a paid scan of the chosen pages for blanks without a native field); pass estimate: true first to see the cost without uploading. Results are cached locally, so repeat calls and narrowing with `pages` are free. If it returns status "running", call it again with the same arguments. To correct the layout and keep the corrections, analyze with save_as_template: true (edits on an unsaved analysis can be used for filling/preview but can\'t be saved). A rate-limit or busy refusal is waited out automatically (up to about a minute) before it is reported.',
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Absolute path (or ~/…) to the blank PDF."),
        pages: PAGES.describe(
          '1-based pages to analyze, e.g. "1-3,5". Omit for all. Long PDFs: analyze in chunks; fill_form merges them.',
        ),
        save_as_template: z
          .boolean()
          .optional()
          .describe("Also save it as a fenfill template (for fill_template and recipient links)."),
        access: z
          .enum(["public", "restricted"])
          .optional()
          .describe(
            'With save_as_template: "public" (default; anyone with the template link can fill it) or "restricted" (members and recipient links only). create_recipient_link needs "restricted".',
          ),
        force: z.boolean().optional().describe("Re-analyze even if cached (costs scans again)."),
        estimate: z
          .boolean()
          .optional()
          .describe(
            "Only estimate, uploading nothing: counts pages and detects native form fields on this machine, then returns {page_count, likely_mode, estimated_scans, scans_remaining}.",
          ),
        detect_extra_blanks: z
          .boolean()
          .optional()
          .describe(
            "PDFs with native form fields: also find blanks that have no native field (e.g. a signature or date line), with a vision pass over the chosen pages: 1 page scan per page (pass pages to limit it). Ignored (no extra cost) when the form is analyzed by AI anyway. A free analysis reports extra_blanks_available: true when this is likely worth it.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run("analyze_form", async (args, extra, signal) => {
      const token = extra._meta?.progressToken;
      const progress =
        token !== undefined
          ? async (p: number, message?: string) => {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: p,
                  total: 100,
                  ...(message ? { message } : {}),
                },
              });
            }
          : undefined;
      return analyzeForm(
        {
          cache,
          api,
          identity,
          now,
          sleep,
          waitSeconds: waitSecondsFromEnv(env),
          inFlight,
          posts,
          owner,
          editsNote,
        },
        args,
        { signal, progress },
      );
    }),
  );

  // ---- fill_form (offline) -------------------------------------------------------------
  server.registerTool(
    "fill_form",
    {
      title: "Fill an analyzed PDF locally",
      description: `Fill a PDF you analyzed with analyze_form and write a new, flattened PDF. Runs entirely on this machine: no network, and the values never leave it. ${VALUE_SHAPES} Returns filled/skipped counts and warnings, including text shrunk hard or running past its box and filled boxes that overlap; pass check_pdf to see the result.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(4096)
          .describe("The same blank PDF you passed to analyze_form."),
        values: VALUES,
        output_path: OUTPUT_PATH,
        overwrite: OVERWRITE,
        check_pdf: CHECK_PDF,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    run("fill_form", async ({ path, values, output_path, overwrite, check_pdf }) => {
      const { abs, bytes } = await readInputPdf(path);
      const sha = sha256Hex(bytes);
      const merged = mergeAnalyses(await cache.listAnalyses(sha));
      if (!merged) {
        throw new ToolError("not_analyzed", "This PDF hasn't been analyzed on this machine yet.", {
          hint: "Run analyze_form on this file first. fill_form then works offline from the cached analysis.",
        });
      }
      await cache.touchForm(sha);
      const pathRules = { inputAbs: abs, overwrite: overwrite === true, cacheRoot: cache.root };
      const outputAbs = await resolveOutputPath(output_path, pathRules);
      const checkAbs = check_pdf === true ? await checkPathFor(outputAbs, pathRules) : null;
      const templateId = soleTemplateId(merged, null, await identity(false));
      const wc = await fileEdits({ sha, templateId });
      const render = wc ? wc.render : merged.render;
      echo.remember(render, values);
      const res = await stampAndWrite({
        pdfBytes: bytes,
        render,
        agentInput: values,
        fonts: loadFonts(opts.fontsDir),
        branding: null,
        logoBytes: null,
        outputAbs,
        overwrite: overwrite === true,
        cache,
        checkAbs,
      });
      return wc ? { ...res, edited: true, edited_note: EDITED_NOTE } : res;
    }),
  );

  // ---- fill_template -------------------------------------------------------------------
  server.registerTool(
    "fill_template",
    {
      title: "Fill a saved template locally",
      description: `Fill a saved fenfill template and write a flattened PDF. The blank PDF and field schema are downloaded; filling happens on this machine and the values are never sent anywhere. ${VALUE_SHAPES}`,
      inputSchema: {
        template_id: TEMPLATE_ID,
        values: VALUES,
        output_path: OUTPUT_PATH,
        overwrite: OVERWRITE,
        check_pdf: CHECK_PDF,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    run(
      "fill_template",
      async ({ template_id, values, output_path, overwrite, check_pdf }, _extra, signal) => {
        const pathRules = { inputAbs: null, overwrite: overwrite === true, cacheRoot: cache.root };
        const outputAbs = await resolveOutputPath(output_path, pathRules);
        const checkAbs = check_pdf === true ? await checkPathFor(outputAbs, pathRules) : null;
        const client = api();
        const deadline = now() + 60_000;
        const wc = await templateEdits(template_id);
        let render: RenderSchema;
        if (wc) render = wc.render;
        else {
          const { body: tpl } = await client.getJson<AgentSchema & { render?: RenderSchema }>(
            `/templates/${encodeURIComponent(template_id)}?include=render`,
            { signal, deadline },
          );
          if (!tpl.render) {
            throw new ToolError(
              "bad_response",
              "fenfill returned the template without its schema.",
              {
                hint: "Retry shortly.",
              },
            );
          }
          render = tpl.render;
        }
        echo.remember(render, values);
        const { body: account } = await client.getJson<Account>("/account", { signal, deadline });

        const blank = await templateBlank(template_id, signal, deadline);

        let logo: Uint8Array | null = null;
        if (account.branding?.logo && /^[A-Za-z0-9_-]{1,64}$/.test(account.workspace_id)) {
          logo = await cache.readLogo(account.workspace_id);
          if (!logo) {
            logo = await client.getBytes("/account/logo", { signal, deadline, allow404: true });
            if (logo) await cache.writeLogo(account.workspace_id, logo);
          }
        }
        const watermark = account.branding?.watermark === true;
        const branding =
          watermark || logo ? { watermark, logoUrl: logo ? LOGO_SENTINEL : null } : null;

        const res = await stampAndWrite({
          pdfBytes: blank,
          render,
          agentInput: values,
          fonts: loadFonts(opts.fontsDir),
          branding,
          logoBytes: logo ? toArrayBuffer(logo) : null,
          outputAbs,
          overwrite: overwrite === true,
          cache,
          checkAbs,
        });
        return wc
          ? { template_id, ...res, edited: true, edited_note: EDITED_NOTE }
          : { template_id, ...res };
      },
    ),
  );

  // ---- templates ------------------------------------------------------------------------
  server.registerTool(
    "list_templates",
    {
      title: "List saved templates",
      description:
        "List the workspace's saved fenfill templates, newest first. analyzed_pages lists the pages fenfill analyzed: a page missing from it (compare page_count) was never analyzed, so it has no fields yet (reanalyze_template fixes that).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Page size (1–100, default 20)."),
        cursor: z.string().max(512).optional().describe("next_cursor from the previous call."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run("list_templates", async ({ limit, cursor }, _extra, signal) => {
      const q = new URLSearchParams({ limit: String(limit ?? 20) });
      if (cursor) q.set("cursor", cursor);
      return (await api().getJson(`/templates?${q.toString()}`, { signal })).body;
    }),
  );

  server.registerTool(
    "get_template",
    {
      title: "Get a template's fields",
      description:
        "Get a saved template's fillable fields (ids, types, labels) for fill_template. Use pages to narrow a large form. unanalyzed_pages (when present) lists pages fenfill never analyzed: they have no fields yet; reanalyze_template with kind scratch analyzes them.",
      inputSchema: { template_id: TEMPLATE_ID, pages: PAGES },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run("get_template", async ({ template_id, pages }, _extra, signal) => {
      const { body } = await api().getJson<AgentSchema>(
        `/templates/${encodeURIComponent(template_id)}`,
        { signal },
      );
      const requested = pages?.trim() ? parsePageSpec(pages) : null;
      const { unanalyzed } = analyzedPagesOf(body);
      return {
        template_id: body.template_id ?? template_id,
        ...(unanalyzed.length
          ? {
              unanalyzed_pages: unanalyzed,
              unanalyzed_note:
                'These pages were never analyzed, so they have no fields yet. reanalyze_template {template_id, pages, kind: "scratch"} analyzes them (1 page scan per page).',
            }
          : {}),
        ...((await templateEdits(template_id))
          ? {
              has_local_edits: true,
              local_edits:
                "This template has local edits (edit_template) that fill_template and preview_page use; the fields listed are fenfill's saved version. save_template keeps them; edit_template with discard: true drops them.",
            }
          : { has_local_edits: false }),
        ...compactView(
          body,
          requested,
          'This template is too large to list at once. Call get_template again with `pages` (e.g. "1-3") to see its fields.',
        ),
      };
    }),
  );

  // ---- recipients --------------------------------------------------------------------------
  server.registerTool(
    "create_recipient_link",
    {
      title: "Create a recipient link",
      description:
        'Create a personal fill link for one recipient of a restricted template (analyze_form with save_as_template: true and access: "restricted" makes one; a public template answers template_not_restricted). Needs a plan with recipient links. Track it with get_recipient_status.',
      inputSchema: {
        template_id: TEMPLATE_ID,
        label: z.string().min(1).max(60).describe("Who it's for, e.g. a name (1–60 characters)."),
        expires_at: z
          .string()
          .max(64)
          .optional()
          .describe("Optional ISO 8601 expiry, e.g. 2026-12-31T23:59:59Z."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run("create_recipient_link", async ({ template_id, label, expires_at }, _extra, signal) => {
      return api().postJson(
        `/templates/${encodeURIComponent(template_id)}/recipients`,
        { label, expires_at: expires_at ?? null },
        { signal },
      );
    }),
  );

  server.registerTool(
    "get_recipient_status",
    {
      title: "Recipient link status",
      description:
        "List a template's recipient links and their status (pending, opened, completed).",
      inputSchema: { template_id: TEMPLATE_ID },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run("get_recipient_status", async ({ template_id }, _extra, signal) => {
      return (
        await api().getJson(`/templates/${encodeURIComponent(template_id)}/recipients`, { signal })
      ).body;
    }),
  );

  // ---- account ------------------------------------------------------------------------------
  server.registerTool(
    "get_account",
    {
      title: "Account and limits",
      description:
        "Show this API key's plan, page scans left and limits. To price an analysis, call analyze_form with estimate: true instead: it counts the pages and detects native fields locally, with no upload, and compares that with scans_remaining.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run("get_account", async (_args, _extra, signal) => {
      return (await api().getJson<Account>("/account", { signal })).body;
    }),
  );

  // ---- preview_page (local render) -------------------------------------------------------
  server.registerTool(
    "preview_page",
    {
      title: "Preview a page with its field boxes",
      description: `Render one page as a PNG with every field box outlined (green filled, orange warning, red skipped, grey empty) and tagged with its id prefix, plus a legend: tag → id, type, label, box (page fractions, top-left origin, as edit_template uses), format and font_pt; options, table cells (row, col) and table_rows columns with their own boxes. placement_warnings ([] = checked, clean) covers every box shown: much larger text than the page's other fields, a box over printed text (not on scans), a box past its ruled cell. Use it as a read-only placement audit. values (see that parameter) stamp test values. crop + zoom magnify a region; legend: "changed" lists only what changed since your last preview of the page (moved_into: fields now inside a table or group). It renders the local working copy (edit_template) when one exists, else the saved or analyzed version (edited: true/false). Rendered on this machine: nothing is written to disk and the values are never sent anywhere.`,
      inputSchema: {
        path: TARGET_PATH,
        template_id: TARGET_TEMPLATE,
        page: z.number().int().min(1).max(100_000).describe("1-based page number."),
        values: VALUES.optional().describe(`Optional, exactly as for fill_form: ${VALUE_SHAPES}`),
        dpi: z
          .number()
          .int()
          .min(36)
          .max(MAX_DPI)
          .optional()
          .describe(`Resolution (default ${String(DEFAULT_DPI)}, max ${String(MAX_DPI)}).`),
        crop: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().gt(0).max(1),
            h: z.number().gt(0).max(1),
          })
          .optional()
          .describe(
            "Optional: render only this region of the page (fractions, top-left origin, like the legend boxes), magnified by zoom. The legend then lists only what the region shows.",
          ),
        zoom: z
          .number()
          .min(1)
          .max(MAX_ZOOM)
          .optional()
          .describe(`With crop: magnification (default 2, max ${String(MAX_ZOOM)}).`),
        legend: z
          .enum(["all", "changed", "none"])
          .optional()
          .describe(
            'Which legend rows to return: "all" (default), "changed" (only what changed since your last preview of this page, or, the first time, since fenfill\'s version; plus removed ids), or "none".',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      maybeSweep();
      const signal = AbortSignal.any([extra.signal, stop.signal]);
      try {
        oneTarget(args);
        const values = args.values ?? {};
        let bytes: Uint8Array;
        let render: RenderSchema;
        let wc: WorkingCopy | null;
        let legendKey: string;
        if (args.path) {
          const f = await fileForm(args.path);
          legendKey = `file:${f.sha}`;
          await cache.touchForm(f.sha);
          wc = await fileEdits(f);
          bytes = f.bytes;
          render = wc ? wc.render : f.merged.render;
        } else {
          const id = args.template_id as string;
          legendKey = `template:${id}`;
          wc = await templateEdits(id);
          render = wc ? wc.render : (await fetchTemplate(id, signal)).render;
          bytes = await templateBlank(id, signal);
        }
        echo.remember(render, values);
        const pv = await previewPage({
          pdfBytes: bytes,
          render,
          page: args.page,
          values,
          dpi: args.dpi,
          fonts: loadFonts(opts.fontsDir),
          crop: args.crop,
          zoom: args.zoom,
        });
        // Placement over every box the page (or crop) shows: a gold review
        // must see a box sitting on a printed hint before it edits anything.
        const placement = await placementWarnings(
          bytes,
          render,
          pv.legend.map((r) => r.id),
          { pageWide: true, cells: true },
        ).catch(() => []);
        // Resolved font sizes for the legend's single-line fields.
        const sizes = await stampedSizes(bytes, render, args.page).catch(
          () => new Map<string, { font_pt: number; font_auto: boolean }>(),
        );
        for (const row of pv.legend) Object.assign(row, sizes.get(row.id) ?? {});
        // legend: "changed" diffs this page's rows against the last preview of
        // it (in this session), or the first time against fenfill's version.
        const key = `${legendKey}#${String(args.page)}`;
        const full = legendRows(render, args.page);
        const before =
          lastLegend.get(key) ?? legendPrints(wc ? legendRows(wc.base, args.page) : full);
        lastLegend.set(key, legendPrints(full));
        const mode = args.legend ?? "all";
        const shownIds = new Set(pv.legend.map((r) => r.id));
        const diff = mode === "changed" ? legendChanges(before, full) : null;
        const changes = diff && {
          changed: diff.changed.filter((r) => shownIds.has(r.id)),
          removed: diff.removed,
          moved_into: diff.moved_into,
        };
        const meta = {
          page: args.page,
          width: pv.width,
          height: pv.height,
          dpi: pv.dpi,
          ...(wc
            ? { edited: true, edited_note: EDITED_NOTE }
            : {
                edited: false,
                source: args.path ? "analysis (no local edits)" : "saved template (no local edits)",
              }),
          colours:
            "green = filled, orange = filled with a warning, red = skipped, grey dashed = empty; a radio/multiselect option has a thin box tagged below it",
          ...(args.crop ? { crop: args.crop } : {}),
          ...(mode === "none"
            ? {}
            : changes
              ? {
                  legend: changes.changed,
                  legend_mode: "changed",
                  ...(changes.removed.length ? { removed: changes.removed } : {}),
                  ...(changes.moved_into.length ? { moved_into: changes.moved_into } : {}),
                }
              : { legend: pv.legend }),
          ...(Object.keys(values).length ? { filled: pv.filled } : {}),
          ...(pv.skipped.length ? { skipped: pv.skipped } : {}),
          // Always present: [] means checked and clean, never "not computed".
          warnings: pv.warnings,
          placement_warnings: placement,
        };
        log("info", "tool ok", { tool: "preview_page", ms: Date.now() - t0 });
        return {
          content: [
            { type: "image", data: Buffer.from(pv.png).toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify(meta) },
          ],
        };
      } catch (e) {
        const err = asToolError(e);
        log("warn", "tool failed", { tool: "preview_page", code: err.code, ms: Date.now() - t0 });
        return fail(err);
      }
    },
  );

  // ---- edit_template (local working copy) -------------------------------------------------
  server.registerTool(
    "edit_template",
    {
      title: "Correct a form's fields locally",
      description: `Correct a form's fields on this machine: move, resize, relabel, retype, add, delete or regroup fields of an analyzed PDF (path) or a saved template (template_id). Edits go to a local working copy that fill_form, fill_template and preview_page use at once; nothing is sent until save_template, and then only the layout and the form's wording. Labels, descriptions, placeholders and options hold the FORM's own wording (its captions and instructions), never the user's answers: answers go only in fill values. Ids are the ones analyze_form / get_template / preview_page show (an option or table cell id addresses that box); any id may be shortened to an unambiguous prefix of 6+ characters, like the preview tags. Coordinates are fractions of the page (0–1), top-left origin, x right, y down; preview_page's legend shows every box. Returns applied, rejected [{op_index, reason}], diff_summary (ops: snapped, noop per op) and warnings ([] = none; placement checks touched boxes: oversized text, over printed text, past the ruled cell). Edits to an unsaved analysis stay local: to keep corrections, analyze_form with save_as_template: true and edit that template.`,
      inputSchema: {
        path: TARGET_PATH,
        template_id: TARGET_TEMPLATE,
        ops: z
          .array(z.record(z.string(), z.unknown()))
          .max(MAX_OPS)
          .describe(
            `Edit ops, applied in order (max ${String(MAX_OPS)}), each all-or-nothing; a box only has to lie on the page after the whole batch (so move then resize is fine). Fields: set_box {id, x, y, w, h, snap?} (absolute top-left + size; a group scales its members); move {id, dx, dy} or {id, x, y, snap?} (new top-left); resize {id, w, h}; add {page, type: text|multiline|date|checkbox|signature, box: {x, y, w, h}, label, description?, placeholder?, required?, section_id?, snap?} (diff_summary.added gives the new id); snap: "underline" fits the box onto the printed rule under it, "cell" into the ruled box around it, "answer" into that cell's blank part below (or after) its printed caption (read from the page on this machine; a miss keeps your box and warns); relabel {id, label}; retype {id, type} (a radio/multiselect group: radio|multiselect); delete {id}; set_format {id, format: {...}} (font_size, text_anchor, variant, date_format: DD/MM/YYYY|MM/DD/YYYY|YYYY-MM-DD|DD.MM.YYYY|DD-MM-YYYY; null removes a key; on a table cell it applies to the cell's whole column/row; a comb group: cell_type, date_format with one D/M/Y letter per cell); set_required {id, required}; set_description {id, description}; set_placeholder {id, placeholder} (null clears); set_autofill {id, autofill: a browser token (name, given-name, family-name, email, tel, street-address, postal-code, bday, …) or null}. Groups: group {ids, kind: "choice"|"comb", label, multiple?} (standalone fields on one page; choice turns them into checkbox options); ungroup {id}; set_options {id, options: ["label", …] in listed order, or [{id, label}]}; add_option {id: group, label, box, index?} and remove_option {id: group, option} keep the group's id. Tables: group {kind: "table", label, cells: [[id|null, …], …] (rows × columns) or ids (laid out from their boxes), header_cols?, header_rows?, orientation?: "col"|"row" (the axis whose lines carry the types; default col), format?: classic|expandable|checkbox_matrix}; table_insert {id, axis: "row"|"col", index, box?: {y, h} for a row / {x, w} for a column (default: one pitch past the edge, or centred in the gap), header?, type?}; table_delete {id, axis, index, keep_cells?}; table_add_cell {id, row, col, box?} (fills an empty slot); table_adopt {id, field, row, col} (moves a loose field into an empty slot); set_column_type {id, index, type: text|number|currency|date|checkbox, date_format?} (index along the typed axis); set_orientation {id, orientation} (resets every cell to text); set_header {id, axis, index, text}; set_headers {id, axis, texts: [...], start?} (several at once). Order: reorder {page, ids} moves those top-level entries together, in that order, to where the first sat (stamps order; geometry no longer decides). Every cell of one column (or row, when orientation is row) has one type.`,
          ),
        discard: z
          .boolean()
          .optional()
          .describe("Drop the local working copy first (any ops then apply to fenfill's version)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run("edit_template", async ({ path, template_id, ops, discard }, _extra, signal) => {
      oneTarget({ path, template_id });
      const who = await identity(false);
      let key: string;
      let saveTarget: string | null;
      let base: () => Promise<{
        render: RenderSchema;
        updated_at: string | null;
        sha: string | null;
      }>;
      let fileSha: string | null = null;
      let fileBytes: Uint8Array | null = null;
      if (path) {
        const f = await fileForm(path);
        fileBytes = f.bytes;
        if (f.templateId) {
          // The file is wholly one saved template: edit that template, based
          // on fenfill's copy exactly as served (what save_template sends back).
          const tid = f.templateId;
          fileSha = f.sha;
          key = editKeyForTemplate(tid);
          saveTarget = tid;
          base = async () => ({ ...(await fetchTemplate(tid, signal)), sha: f.sha });
        } else {
          key = editKeyForFile(f.sha);
          saveTarget = null;
          base = async () => ({ render: f.merged.render, updated_at: null, sha: f.sha });
        }
      } else {
        const tid = template_id as string;
        key = editKeyForTemplate(tid);
        saveTarget = tid;
        base = async () => ({ ...(await fetchTemplate(tid, signal)), sha: null });
      }

      let discarded = false;
      if (discard === true) discarded = await cache.deleteEdits(key);
      let wc = await cache.readEdits(key);
      if (wc && saveTarget && !sameAccount(wc, who)) wc = null; // another account's copy
      const nowIso = new Date(now()).toISOString();
      if (!wc && ops.length === 0) {
        return {
          target: saveTarget ? { template_id: saveTarget } : { path },
          applied: 0,
          rejected: [],
          ...(discard === true ? { discarded } : {}),
          has_edits: false,
        };
      }
      if (!wc) {
        const b = await base();
        wc = {
          v: 1,
          key,
          template_id: saveTarget,
          sha256: b.sha,
          base_updated_at: b.updated_at,
          base: b.render,
          render: b.render,
          created_at: nowIso,
          updated_at: nowIso,
          ops_applied: 0,
          ...(who ? { api_origin: who.api_origin, account: who.account } : {}),
          writer,
        };
      }
      // The blank PDF (snap and the placement warnings read its render and text
      // layer, locally): the file itself, or the saved template's, downloaded once.
      const target = saveTarget;
      let blankBytes: Promise<Uint8Array> | null = null;
      const blank = () =>
        (blankBytes ??= fileBytes
          ? Promise.resolve(fileBytes)
          : templateBlank(target as string, signal));
      const pages = snapPages(ops, (id) => pageOfId(wc.render, id));
      let snap: Snapper | undefined;
      if (pages.length) {
        try {
          snap = await prepareSnapper(await blank(), pages);
        } catch (e) {
          if (e instanceof ToolError && e.code === "invalid_page") throw e;
          const why = asToolError(e).message;
          snap = () => ({ none: `no page render (${why})` });
        }
      }
      // The echo guard runs per op, before anything is written: an op whose
      // wording repeats an answer of this session is rejected.
      const r = applyOps(wc.render, ops, (w) => echo.check(w), { snap });
      let placement: string[] = [];
      if (r.applied > 0) {
        const ids = [
          ...r.diff_summary.touched.map((t) => t.id),
          ...r.diff_summary.added.map((a) => a.id),
        ];
        placement = await blank()
          .then((pdf) => placementWarnings(pdf, r.render, ids, { cells: true }))
          .catch(() => []);
      }
      // Taking over a copy whose changed wording another process wrote: that
      // wording stays unvouched until save_template's confirm_wording.
      const inherited =
        wc.inherited_wording === true ||
        (wc.writer?.owner !== owner && changedWording(wc.base, wc.render).length > 0);
      const out: WorkingCopy = {
        ...wc,
        render: r.render,
        updated_at: nowIso,
        ops_applied: wc.ops_applied + r.applied,
        writer,
        ...(inherited ? { inherited_wording: true as const } : {}),
      };
      const existed = (await cache.readEdits(key)) !== null;
      if (r.applied > 0) {
        await cache.writeEdits(out);
        // A new template copy supersedes its PDF's own (unsaved-analysis) copy.
        if (saveTarget && !existed) {
          await dropFileCopies(saveTarget, fileSha).catch(() => undefined);
        }
      }
      const hasEdits = r.applied > 0 || existed;
      const left = hasEdits ? schemaIssues(out.render, 10) : [];
      return {
        target: saveTarget ? { template_id: saveTarget } : { path },
        applied: r.applied,
        rejected: r.rejected,
        diff_summary: r.diff_summary,
        ...(discard === true ? { discarded } : {}),
        warnings: [
          ...r.warnings,
          ...placement,
          ...left.map(
            (i) =>
              `${i.id ? `${i.id}: ` : ""}${i.path} ${i.reason} (fenfill would refuse to save this; fix it with another op)`,
          ),
        ],
        has_edits: hasEdits,
        ops_applied_total: out.ops_applied,
        saveable: !!saveTarget,
        next: saveTarget
          ? "Check with preview_page (or fill_form with check_pdf), then save_template to keep the edits in the saved template."
          : "These edits stay on this machine (fill_form and preview_page use them). This is an unsaved analysis, so save_template can't keep them: to keep corrections, analyze_form with save_as_template: true and edit that template.",
      };
    }),
  );

  // ---- save_template ----------------------------------------------------------------------
  server.registerTool(
    "save_template",
    {
      title: "Save local edits to a template",
      description:
        "Save edit_template's local working copy of a saved template to fenfill (only the layout and the form's wording are sent; never fill values). Fails safely if the template changed in fenfill since the edits began (template_conflict: the local edits are kept; discard and re-apply them), and refuses wording that repeats an answer given to fill_form / fill_template / preview_page in this session (answers never go into a template). Wording edited in an earlier session can't be checked that way: save_template then answers confirm_wording_needed with the changed ids and properties; review that wording (preview_page shows labels) and call again with confirm_wording: true. An unsaved analysis can't be saved: analyze it again with save_as_template: true (free on a native-field PDF; otherwise it costs scans again), then edit that template.",
      inputSchema: {
        template_id: TEMPLATE_ID,
        confirm_wording: z
          .boolean()
          .optional()
          .describe(
            "Only after a confirm_wording_needed error: true confirms you reviewed the listed wording (edited in an earlier session) and it is the form's own text, not an answer.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run("save_template", async ({ template_id, confirm_wording }, _extra, signal) => {
      const wc = await templateEdits(template_id);
      if (!wc) {
        // Nothing to save is a success, not an error: fenfill's copy is already current.
        return {
          template_id,
          saved: false,
          nothing_to_save: true,
          note: "No local edits for this template: fenfill's copy is already the current one (e.g. right after a save or reanalyze_template, or before any edit_template). Edits to an unsaved analysis can't be saved: analyze_form with save_as_template: true first, then edit that template.",
        };
      }

      // 1. The echo guard: wording that repeats an answer never leaves.
      const changed = changedWording(wc.base, wc.render);
      const echoed = echo.check(changed);
      if (echoed.refuse.length) {
        throw new ToolError(
          "answer_in_template",
          "Some edited wording matches an answer you filled in this session, so it was not sent.",
          {
            hint: "Labels, descriptions, placeholders and options hold the form's own wording, never an answer. Fix those items with edit_template (relabel / set_description / set_placeholder / set_options), then save again.",
            details: { ids: echoed.refuse },
          },
        );
      }
      // Wording an earlier process wrote: this session's guard can't vouch for it.
      const foreign = wc.writer?.owner !== owner || wc.inherited_wording === true;
      if (foreign && changed.length && confirm_wording !== true) {
        throw new ToolError(
          "confirm_wording_needed",
          "This working copy has wording edited in an earlier session, which this session's answer check can't cover, so it was not sent.",
          {
            hint: "Review the wording listed in `changed` (those properties of each id) and make sure it is the form's own text, never an answer. Fix anything wrong with edit_template, then call save_template again with confirm_wording: true.",
            details: { changed: wordingChanges(changed) },
          },
        );
      }

      // 2. What fenfill would refuse, refused here first.
      const issues = schemaIssues(wc.render);
      if (issues.length) {
        throw new ToolError(
          "invalid_schema",
          "The edited layout isn't valid, so it was not sent.",
          {
            hint: "Fix these items with edit_template, then save again.",
            details: { details: issues },
          },
        );
      }
      if (!wc.base_updated_at) {
        throw new ToolError(
          "missing_version",
          "fenfill didn't say which version of this template the edits started from.",
          {
            hint: "edit_template with template_id and discard: true, re-apply the ops, then save.",
          },
        );
      }

      // 3. One conditional PATCH (sent once; page images stay as received).
      const schema = { ...wc.render, pages: wc.base.pages };
      let saved: TemplateUpdated;
      try {
        saved = await api().patchJson<TemplateUpdated>(
          `/templates/${encodeURIComponent(template_id)}`,
          { schema, expected_updated_at: wc.base_updated_at },
          { signal },
        );
      } catch (e) {
        if (e instanceof ToolError && e.code === "template_conflict") {
          let server: Record<string, unknown> = {};
          try {
            const cur = await fetchTemplate(template_id, signal);
            server = {
              current_updated_at: cur.updated_at,
              server_fields: cur.render.fields.length,
              server_groups: cur.render.groups.length,
            };
          } catch {
            // the conflict stands on its own
          }
          throw new ToolError(e.code, e.message, {
            hint: e.hint,
            status: e.status,
            details: {
              ...e.details,
              ...server,
              local_edits_kept: true,
              edits_since: wc.created_at,
            },
          });
        }
        if (e instanceof ToolError && e.code === "invalid_schema") {
          const items = Array.isArray(e.details.details) ? (e.details.details as unknown[]) : [];
          throw new ToolError(e.code, e.message, {
            hint: e.hint,
            status: e.status,
            details: { ...e.details, details: items.map((it) => withItemId(it, schema)) },
          });
        }
        throw e;
      }

      // 4. Saved: the server copy is now the edited one (and any unsaved-analysis
      // copy of its PDF is stale).
      await cache.deleteEdits(wc.key);
      await dropFileCopies(template_id, wc.sha256).catch(() => undefined);
      await refreshSavedAnalyses(cache, template_id, schema, saved, await identity(false));
      return {
        template_id: saved.template_id ?? template_id,
        saved: true,
        updated_at: saved.updated_at,
        // Agent entries (get_template's unit) of the whole saved template.
        ...(() => {
          try {
            const n = agentEntries(
              normalizeSchema(saved.result as unknown as Parameters<typeof normalizeSchema>[0]),
            ).length;
            return { field_count: n, field_count_total: n };
          } catch {
            return {};
          }
        })(),
        ...(echoed.warn.length
          ? {
              warnings: [
                `${echoed.warn.join(", ")}: short wording that matches a short answer from this session (allowed under 4 characters); check it is the form's own text`,
              ],
            }
          : {}),
        next: "fill_template, get_template and recipient links now use the saved layout.",
      };
    }),
  );

  // ---- reanalyze_template ------------------------------------------------------------------
  server.registerTool(
    "reanalyze_template",
    {
      title: "Re-analyze pages of a saved template",
      description:
        'Re-run fenfill\'s analysis on some pages of a SAVED template, using the blank PDF already stored with it (nothing is uploaded). Spot never-analyzed pages with get_template (unanalyzed_pages) or list_templates (analyzed_pages vs page_count). kind: "scratch" (default; only allowed when the pages have no fields) analyzes a never-analyzed page, or replaces a badly analyzed one\'s fields; "find" adds blanks the first pass missed and keeps everything else; "relabel" re-derives labels, types, groups and sections keeping the boxes (relabel may reset table column types/orientation; check get_template after); "label_missing" fills in only missing labels. Cost: 1 page scan per page; label_missing is free within the workspace\'s monthly free-label allowance. Pass estimate: true first to price it (starts nothing). Unsaved local edits (edit_template) must be saved (save_template) or dropped (discard: true) first. Returns the pages\' changes (added / removed / changed fields) and their new fields. If it returns status "running", call it again with the same arguments (no extra charge). A rate-limit or busy refusal is waited out automatically (up to about a minute).',
      inputSchema: {
        template_id: TEMPLATE_ID,
        pages: z
          .string()
          .min(1)
          .max(2000)
          .describe('1-based pages to re-analyze, e.g. "2" or "2-4".'),
        kind: z
          .enum(RERUN_KINDS)
          .optional()
          .describe(
            "scratch | find | relabel | label_missing (see the description). Omit only for pages with no fields (= scratch).",
          ),
        estimate: z
          .boolean()
          .optional()
          .describe(
            "Only price it: returns {cost, scans_left, free_label_pages, insufficient, …} and starts nothing.",
          ),
        discard: z
          .boolean()
          .optional()
          .describe(
            "Drop this template's unsaved local edits (edit_template) when the re-analysis finishes, instead of refusing.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run("reanalyze_template", async (args, extra, signal) => {
      const token = extra._meta?.progressToken;
      const progress =
        token !== undefined
          ? async (p: number, message?: string) => {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: p,
                  total: 100,
                  ...(message ? { message } : {}),
                },
              });
            }
          : undefined;
      return reanalyzeTemplate(
        {
          cache,
          api,
          identity,
          now,
          sleep,
          waitSeconds: waitSecondsFromEnv(env),
          posts,
          owner,
          templateEdits,
          dropFileCopies: (tid) => dropFileCopies(tid, null),
        },
        args,
        { signal, progress },
      );
    }),
  );

  // Best effort: a client that closes stdin and then signals gives us seconds,
  // not the full grace period (a second signal exits at once, see lifecycle.ts).
  const shutdown = async (graceMs = 30_000) => {
    stop.abort();
    if (posts.size) {
      log("info", "waiting for analyze uploads", { count: posts.size });
      await Promise.race([
        Promise.allSettled([...posts]),
        sleepTimer(graceMs, undefined, { ref: false }),
      ]);
    }
    LIVE_OWNERS.delete(owner);
    await server.close().catch(() => undefined);
  };

  return { server, shutdown };
}
