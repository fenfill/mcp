// Bundle smoke: runs the BUILT server (dist/, copied outside the repo so no
// node_modules can leak in) over real stdio with the SDK's StdioClientTransport,
// and fills a plain and an owner-password-encrypted PDF fully offline from a
// pre-seeded cache. Asserts: exactly the 12 tools; the outputs are stamped and
// tagged; preview_page renders a PNG with the bundled pdfium.wasm, offline;
// edit_template works offline on an unsaved analysis; stdout carried nothing
// but JSON-RPC (also checked on a raw spawn).
//
// Run via `npm run smoke` (which builds first).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "../..");

// pdf-lib / @cantoo/pdf-lib: the app's copies (test-only; the bundle has its own).
const { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } =
  await import("pdf-lib");
const { PDFDocument: CantooDocument } = await import("@cantoo/pdf-lib");

const EXPECTED_TOOLS = [
  "analyze_form",
  "create_recipient_link",
  "edit_template",
  "fill_form",
  "fill_template",
  "get_account",
  "get_recipient_status",
  "get_template",
  "list_templates",
  "preview_page",
  "reanalyze_template",
  "save_template",
];

// ---- fixtures ------------------------------------------------------------------------------

const RENDER = {
  version: 5,
  pages: [{ page: 1, width: 1700, height: 2200, image: "", sections: [] }],
  fields: [
    {
      id: "name",
      label: "Full name",
      type: "text",
      page: 1,
      section_id: null,
      group: null,
      xpct: 10,
      ypct: 10,
      wpct: 40,
      hpct: 4,
    },
    {
      id: "agree",
      label: "I agree",
      type: "checkbox",
      page: 1,
      section_id: null,
      group: null,
      xpct: 10,
      ypct: 20,
      wpct: 3,
      hpct: 3,
    },
    {
      id: "m1",
      label: "Yes",
      type: "checkbox",
      page: 1,
      section_id: null,
      group: "g1",
      xpct: 10,
      ypct: 30,
      wpct: 3,
      hpct: 3,
    },
    {
      id: "m2",
      label: "No",
      type: "checkbox",
      page: 1,
      section_id: null,
      group: "g1",
      xpct: 20,
      ypct: 30,
      wpct: 3,
      hpct: 3,
    },
  ],
  groups: [
    {
      id: "g1",
      kind: "choice",
      format: "single",
      label: "Married?",
      page: 1,
      members: ["m1", "m2"],
    },
  ],
};
const entry = (o) => ({
  page: 1,
  box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
  section: null,
  required: false,
  description: null,
  placeholder: null,
  autofill: null,
  ...o,
});
const AGENT = {
  schema_version: 1,
  template_id: null,
  name: "Smoke form",
  page_count: 1,
  pages: [{ page: 1, width: 1700, height: 2200 }],
  fields: [
    entry({ id: "name", type: "text", label: "Full name" }),
    entry({ id: "agree", type: "checkbox", label: "I agree" }),
    entry({
      id: "g1",
      type: "radio",
      label: "Married?",
      options: [
        { id: "m1", label: "Yes" },
        { id: "m2", label: "No" },
      ],
    }),
  ],
};

async function plainPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

async function encryptedPdf() {
  const doc = await CantooDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("Native").addToPage(page, { x: 300, y: 50, width: 120, height: 18 });
  doc.encrypt({
    ownerPassword: "owner-secret",
    userPassword: "",
    algorithm: "AES-128",
    allowWeakCryptography: true,
    permissions: { fillingForms: true, modifying: false },
  });
  return doc.save();
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function seed(cacheDir, bytes) {
  const sha = sha256(bytes);
  const dir = join(cacheDir, "forms", sha);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rec = {
    v: 1,
    sha256: sha,
    options: { pages: null, save_as_template: false },
    job_id: "00000000-0000-4000-8000-000000000000",
    template_id: null,
    mode: "ai",
    cost: 1,
    pages: [1],
    page_count: 1,
    render: RENDER,
    agent: AGENT,
    at: new Date().toISOString(),
  };
  writeFileSync(join(dir, "p1.json"), JSON.stringify(rec), { mode: 0o600 });
}

// ---- stamped-text oracle (glyph ids → text via the subset fonts' /ToUnicode) -------------

function stampedText(bytes) {
  return PDFDocument.load(bytes).then((doc) => {
    const latin1 = (s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
    const map = new Map();
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const tu = obj.get(PDFName.of("ToUnicode"));
      const s = tu && doc.context.lookup(tu);
      if (!(s instanceof PDFRawStream)) continue;
      const txt = latin1(s);
      for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
          map.set(
            m[1].padStart(4, "0").toUpperCase(),
            String.fromCharCode(parseInt(m[2].slice(0, 4), 16)),
          );
        }
      }
      for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of blk[1].matchAll(
          /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
        )) {
          for (
            let c = parseInt(m[1], 16), u = parseInt(m[3], 16);
            c <= parseInt(m[2], 16);
            c++, u++
          ) {
            map.set(c.toString(16).padStart(4, "0").toUpperCase(), String.fromCharCode(u));
          }
        }
      }
    }
    const contents = doc.getPage(0).node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r))
        : [contents];
    let out = "";
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      for (const m of latin1(s).matchAll(/<([0-9A-Fa-f]{4,})>/g)) {
        for (let i = 0; i + 4 <= m[1].length; i += 4)
          out += map.get(m[1].slice(i, i + 4).toUpperCase()) ?? "";
        out += " ";
      }
    }
    return out;
  });
}

async function hasTag(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof PDFDict && info.has(PDFName.of("FenfillMcpOutput"));
}

// ---- run ---------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "fenfill-mcp-smoke-"));
try {
  assert.ok(!work.startsWith(REPO), "the smoke dir must be outside the repo");
  const bin = join(work, "bin");
  cpSync(join(PKG, "dist"), bin, { recursive: true });
  const cacheDir = join(work, "cache");
  mkdirSync(cacheDir, { mode: 0o700 });

  const plain = await plainPdf();
  const enc = await encryptedPdf();
  await assert.rejects(PDFDocument.load(enc), /encrypted/i, "fixture must be encrypted");
  const plainPath = join(work, "plain.pdf");
  const encPath = join(work, "encrypted.pdf");
  writeFileSync(plainPath, plain);
  writeFileSync(encPath, enc);
  seed(cacheDir, plain);
  seed(cacheDir, enc);

  const childEnv = {
    FENFILL_CACHE_DIR: cacheDir,
    // Unroutable on purpose: fill_form must never need it.
    FENFILL_API_URL: "https://127.0.0.1:9",
    PATH: process.env.PATH ?? "",
  };

  // 1) The SDK stdio client.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(bin, "index.js")],
    env: childEnv,
    cwd: work,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const protocolErrors = [];
  const client = new Client({ name: "smoke", version: "0.0.0" });
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "fenfill");

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);

  const values = { name: "Smoke Test Ada", agree: true, g1: "No" };
  for (const [label, input] of [
    ["plain", plainPath],
    ["encrypted", encPath],
  ]) {
    const out = join(work, `${label}-filled.pdf`);
    const r = await client.callTool({
      name: "fill_form",
      arguments: { path: input, values, output_path: out },
    });
    const body = JSON.parse(r.content[0].text);
    assert.ok(!r.isError, `${label}: ${r.content[0].text}`);
    assert.equal(body.filled, 3, `${label}: filled`);
    assert.deepEqual(body.skipped, [], `${label}: skipped`);
    const bytes = readFileSync(out);
    const text = await stampedText(bytes);
    assert.match(text, /Smoke Test Ada/, `${label}: stamped text`);
    assert.ok(await hasTag(bytes), `${label}: FenfillMcpOutput tag`);
    process.stderr.write(`smoke: ${label} fill ok (${bytes.length} bytes)\n`);
  }

  // preview_page: the bundled pdfium.wasm renders the check copy, offline.
  const pv = await client.callTool({
    name: "preview_page",
    arguments: { path: plainPath, page: 1, values, dpi: 72 },
  });
  assert.ok(!pv.isError, `preview_page: ${JSON.stringify(pv.content).slice(0, 300)}`);
  assert.equal(pv.content[0].type, "image");
  assert.equal(pv.content[0].mimeType, "image/png");
  const png = Buffer.from(pv.content[0].data, "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [612, 792]);
  const legend = JSON.parse(pv.content[1].text).legend;
  assert.ok(
    legend.some((l) => l.id === "name" && l.label === "Full name"),
    "preview legend",
  );
  process.stderr.write(`smoke: preview_page ok (${png.length} bytes PNG)\n`);

  // edit_template on the unsaved analysis: local, then used by fill_form.
  const ed = await client.callTool({
    name: "edit_template",
    arguments: { path: plainPath, ops: [{ op: "move", id: "name", dy: 0.05 }] },
  });
  assert.ok(!ed.isError, ed.content[0].text);
  assert.equal(JSON.parse(ed.content[0].text).applied, 1);
  const edOut = join(work, "edited-filled.pdf");
  const edFill = await client.callTool({
    name: "fill_form",
    arguments: { path: plainPath, values, output_path: edOut },
  });
  assert.equal(JSON.parse(edFill.content[0].text).edited, true);

  // 0.2.0 table ops against the bundle: two added boxes → a table → a new row,
  // then a cropped preview whose legend lists the table's cells by (row, col).
  const call = async (args) => {
    const r = await client.callTool({
      name: "edit_template",
      arguments: { path: plainPath, ...args },
    });
    assert.ok(!r.isError, r.content[0].text);
    const body = JSON.parse(r.content[0].text);
    assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));
    return body;
  };
  const two = await call({
    ops: [
      {
        op: "add",
        page: 1,
        type: "date",
        box: { x: 0.1, y: 0.6, w: 0.2, h: 0.025 },
        label: "Date",
      },
      {
        op: "add",
        page: 1,
        type: "text",
        box: { x: 0.35, y: 0.6, w: 0.4, h: 0.025 },
        label: "Reason",
      },
    ],
  });
  const [d0, r0] = two.diff_summary.added.map((a) => a.id);
  const tbl = await call({
    ops: [
      {
        op: "group",
        kind: "table",
        label: "Visits",
        cells: [[d0.slice(0, 8), r0]],
        header_cols: ["Date", "Reason"],
      },
    ],
  });
  const tid = tbl.diff_summary.added[0].id;
  await call({
    ops: [{ op: "table_insert", id: tid, axis: "row", index: 1, box: { y: 0.63, h: 0.025 } }],
  });
  const crop = await client.callTool({
    name: "preview_page",
    arguments: {
      path: plainPath,
      page: 1,
      dpi: 72,
      crop: { x: 0, y: 0.55, w: 1, h: 0.15 },
      zoom: 2,
    },
  });
  assert.ok(!crop.isError, JSON.stringify(crop.content).slice(0, 300));
  const cropMeta = JSON.parse(crop.content[1].text);
  const row = cropMeta.legend.find((l) => l.id === tid);
  assert.equal(row.type, "table");
  assert.deepEqual(
    row.cells.map((c) => [c.row, c.col, c.type]),
    [
      [0, 0, "date"],
      [0, 1, "text"],
      [1, 0, "date"],
      [1, 1, "text"],
    ],
  );
  process.stderr.write("smoke: table ops + cropped preview ok\n");

  // A refused re-analysis of our own output, offline: the tag check runs first.
  const refused = await client.callTool({
    name: "analyze_form",
    arguments: { path: join(work, "plain-filled.pdf") },
  });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /filled_output/);

  await client.close();
  assert.deepEqual(protocolErrors, [], `stdout carried non-JSON-RPC: ${protocolErrors.join("; ")}`);
  assert.doesNotMatch(stderr, /Smoke Test Ada/, "a fill value reached stderr");
  for (const f of readdirSync(cacheDir, { recursive: true })) {
    const p = join(cacheDir, String(f));
    if (statSync(p).isFile()) {
      assert.doesNotMatch(readFileSync(p, "latin1"), /Smoke Test Ada/, `a fill value in ${f}`);
    }
  }

  // 2) A raw spawn: every stdout line must be a JSON-RPC 2.0 message. A preload
  //    calls console.log once the bundle has loaded (as pdf-lib/fontkit can):
  //    the bundle banner must have rerouted it to stderr.
  const PROBE = "STDOUT-PROBE-7c1";
  const preload = `data:text/javascript,setTimeout(()=>console.log(${JSON.stringify(PROBE)}),150)`;
  let rawErr = "";
  const raw = await new Promise((resolveRaw, reject) => {
    const child = spawn(process.execPath, ["--import", preload, join(bin, "index.js")], {
      env: childEnv,
      cwd: work,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (rawErr += d));
    child.on("error", reject);
    child.on("exit", () => resolveRaw(out));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fill_form",
        arguments: { path: encPath, values, output_path: join(work, "raw-filled.pdf") },
      },
    });
    const poll = setInterval(() => {
      if (out.includes('"id":2') && (rawErr.includes(PROBE) || out.includes(PROBE))) {
        clearInterval(poll);
        child.stdin.end();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(poll);
      child.kill();
      reject(new Error("raw spawn timed out"));
    }, 60_000).unref();
  });
  assert.ok(rawErr.includes(PROBE), "the console.log probe should land on stderr");
  assert.ok(!raw.includes(PROBE), "console.log reached stdout");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length >= 2, "expected two responses");
  for (const l of lines) {
    let msg;
    assert.doesNotThrow(() => (msg = JSON.parse(l)), `non-JSON stdout line: ${l.slice(0, 120)}`);
    assert.equal(msg.jsonrpc, "2.0", `non-JSON-RPC stdout line: ${l.slice(0, 120)}`);
  }
  const resp2 = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.ok(resp2 && !resp2.result.isError, `raw fill_form failed: ${JSON.stringify(resp2)}`);

  // 3) Signals: SIGTERM and SIGINT run the shutdown drain and exit cleanly (not
  //    the default die-by-signal), with stdin still open.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    const outcome = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(bin, "index.js")], { env: childEnv, cwd: work });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
        if (err.includes("started")) child.kill(sig);
      });
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`no exit after ${sig}`));
      }, 15_000).unref();
    });
    assert.deepEqual(outcome, { code: 0, signal: null }, `${sig}: ${JSON.stringify(outcome)}`);
  }

  // 4) THIRD_PARTY_NOTICES carries every text of an SPDX AND license (pako: MIT AND Zlib).
  const notices = readFileSync(join(PKG, "THIRD_PARTY_NOTICES"), "utf8");
  for (const block of notices.split(/\n{3}/).filter((b) => /^pako\b/.test(b))) {
    assert.match(block, /Permission is hereby granted/, "pako: MIT text");
    assert.match(block, /provided 'as-is'/, "pako: Zlib text");
  }

  process.stderr.write("smoke: OK\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
