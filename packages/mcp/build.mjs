// Bundles @fenfill/mcp into one dependency-free ESM file (dist/index.js), copies
// the two stamp fonts and PDFium's WebAssembly build (dist/pdfium.wasm, loaded
// lazily by preview_page) next to it and writes THIRD_PARTY_NOTICES from what
// the bundle actually contains (esbuild metafile) plus manual supplements for
// the libraries @pdf-lib/fontkit's UMD build inlines and the ones compiled into
// pdfium.wasm (both invisible to the metafile).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = join(HERE, "dist");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

// Order matters: shebang → stdout guard → CommonJS `require` shim. The guard
// runs before any bundled module body, so pdf-lib / @cantoo/pdf-lib / fontkit
// console.log calls land on stderr and never corrupt the stdio JSON-RPC stream.
const BANNER = [
  "#!/usr/bin/env node",
  "{const e=console.error.bind(console);console.log=e;console.info=e;console.debug=e;}",
  'import { createRequire as __fenfillCreateRequire } from "node:module";',
  "const require = __fenfillCreateRequire(import.meta.url);",
].join("\n");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "fonts"), { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(HERE, "src/index.ts")],
  outfile: join(DIST, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Not minified: the published bundle is the code people can audit (MIT;
  // "fills never leave your machine" should be checkable).
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  tsconfig: join(HERE, "tsconfig.json"),
  banner: { js: BANNER },
  define: { __FENFILL_MCP_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: "warning",
});

for (const f of ["Inter-Regular.ttf", "DejaVuSans.ttf"]) {
  copyFileSync(join(ROOT, "public/fonts", f), join(DIST, "fonts", f));
}

// PDFium (WebAssembly), from the pinned @embedpdf/pdfium. Its JS loader is in
// the bundle; the .wasm ships beside it and is read only by preview_page.
const req = createRequire(join(HERE, "package.json"));
const wasmSrc = req.resolve("@embedpdf/pdfium/pdfium.wasm");
copyFileSync(wasmSrc, join(DIST, "pdfium.wasm"));
const wasmBytes = readFileSync(join(DIST, "pdfium.wasm"));
const wasmSha = createHash("sha256").update(wasmBytes).digest("hex");

// ---- THIRD_PARTY_NOTICES ---------------------------------------------------------------

/** node_modules/<pkg> directories that contributed bytes to the bundle. */
function bundledPackageDirs(metafile) {
  const out =
    metafile.outputs[relative(process.cwd(), join(DIST, "index.js"))] ??
    Object.values(metafile.outputs)[0];
  const dirs = new Map();
  for (const [input, info] of Object.entries(out.inputs)) {
    if (!info.bytesInOutput) continue;
    const abs = resolve(process.cwd(), input);
    const parts = abs.split(sep);
    const i = parts.lastIndexOf("node_modules");
    if (i < 0) continue;
    const scoped = parts[i + 1]?.startsWith("@");
    const name = scoped ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
    const dir = parts.slice(0, i + (scoped ? 3 : 2)).join(sep);
    const prev = dirs.get(dir) ?? { name, bytes: 0 };
    prev.bytes += info.bytesInOutput;
    dirs.set(dir, prev);
  }
  return dirs;
}

function licenseText(dir) {
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f));
  return files
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .join("\n\n");
}

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const BSD3_IEEE754 = `Copyright 2008 Fair Oaks Labs, Inc.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const ISC_INHERITS = `ISC License

Copyright (c) Isaac Z. Schlueter

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

// pako's zlib port (pako is "(MIT AND Zlib)": both texts must ship), verbatim
// from the header of node_modules/pako/lib/zlib/*.js.
const ZLIB_PAKO = `zlib License (the zlib parts of pako)

(C) 1995-2013 Jean-loup Gailly and Mark Adler
(C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
  claim that you wrote the original software. If you use this software
  in a product, an acknowledgment in the product documentation would be
  appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
  misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;

// An SPDX `AND` expression ("(MIT AND Zlib)") means EVERY named license applies,
// so every text must ship. Recognisable texts are checked by signature; a
// missing one is taken from LICENSE_SUPPLEMENTS, and anything else fails the
// build (so a new dependency can't ship with half its notice).
const LICENSE_SIGNATURES = {
  MIT: /Permission is hereby granted, free of charge/i,
  Zlib: /provided 'as-is', without any express or implied\s+warranty/i,
  ISC: /Permission to use, copy, modify, and\/or distribute this software/i,
  "0BSD": /Permission to use, copy, modify, and\/or distribute this software/i,
  "BSD-2-Clause": /Redistribution and use in source and binary forms/i,
  "BSD-3-Clause": /Redistribution and use in source and binary forms/i,
  "Apache-2.0": /Apache License/i,
};
const LICENSE_SUPPLEMENTS = { pako: { Zlib: ZLIB_PAKO } };

/** The licenses an SPDX expression requires together ([] unless it has AND). */
function requiredLicenses(expr) {
  const s = String(expr ?? "").trim();
  if (!/\bAND\b/.test(s)) return [];
  const flat = s.replace(/^\((.*)\)$/, "$1");
  if (/[()]|\bOR\b|\bWITH\b/.test(flat)) {
    throw new Error(`THIRD_PARTY_NOTICES: unsupported SPDX expression "${s}"; review it by hand`);
  }
  return flat.split(/\s+AND\s+/).map((x) => x.trim());
}

/** `text`, plus any license an AND expression requires but the text lacks. */
function completeLicense(name, expr, text) {
  let out = text;
  for (const id of requiredLicenses(expr)) {
    const sig = LICENSE_SIGNATURES[id];
    if (sig && sig.test(out)) continue;
    const extra = LICENSE_SUPPLEMENTS[name]?.[id];
    if (!extra) {
      throw new Error(
        `THIRD_PARTY_NOTICES: ${name} is "${expr}" but its ${id} text is missing; add it to LICENSE_SUPPLEMENTS`,
      );
    }
    out += `\n\n${extra}`;
  }
  return out;
}

// @pdf-lib/fontkit ships a rollup UMD bundle (its package has no LICENSE file)
// that inlines these libraries; the metafile only sees the one UMD file.
// Identified from dist/fontkit.umd.js (@pdf-lib/fontkit 1.1.1).
const FONTKIT_INLINED = [
  [
    "fontkit / @pdf-lib/fontkit",
    MIT("2014 Devon Govett; 2020 Andrew Dillon (@pdf-lib/fontkit fork)"),
  ],
  ["restructure", MIT("2014 Devon Govett")],
  ["tiny-inflate", MIT("2015 Devon Govett")],
  ["unicode-trie", MIT("2014 Devon Govett")],
  ["unicode-properties", MIT("2014 Devon Govett")],
  [
    "brotli (decompressor)",
    MIT("2015 Devon Govett (port of Google's brotli, Copyright 2013 Google Inc.)"),
  ],
  ["dfa", MIT("2016 Devon Govett")],
  ["clone", MIT("2011-2015 Paul Vorbach and contributors")],
  [
    "deep-equal, is-arguments, is-date-object, is-regex, object-is, object-keys, regexp.prototype.flags, define-properties, function-bind, has, has-symbols",
    MIT("2012 James Halliday; 2013-2020 Jordan Harband and contributors"),
  ],
  ["buffer", MIT("Feross Aboukhadijeh and contributors")],
  ["base64-js", MIT("2014 Jameson Little")],
  ["ieee754 (BSD-3-Clause)", BSD3_IEEE754],
  ["events, string_decoder", MIT("Joyent, Inc. and other Node contributors")],
  ["inherits (ISC)", ISC_INHERITS],
  ["safer-buffer", MIT("2018 Nikita Skovoroda")],
  ["iconv-lite", MIT("2011 Alexander Shtuchkin")],
  ["pako", MIT("2014-2017 Vitaly Puzrin and Andrei Tuputcyn"), "(MIT AND Zlib)"],
];

const dirs = bundledPackageDirs(result.metafile);
const blocks = [];
const seen = new Set();
const sizes = [];
for (const [dir, { name, bytes }] of [...dirs.entries()].sort((a, b) =>
  a[1].name.localeCompare(b[1].name),
)) {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    // nested files without their own package.json: skip
  }
  const id = `${meta.name ?? name}@${meta.version ?? "?"}`;
  sizes.push([id, bytes]);
  if (seen.has(id)) continue;
  seen.add(id);
  const text = completeLicense(
    meta.name ?? name,
    meta.license,
    licenseText(dir) ||
      (meta.license === "MIT"
        ? MIT(String(meta.author?.name ?? meta.author ?? `the ${name} authors`))
        : ""),
  );
  blocks.push(
    `${id} (${meta.license ?? "see text"})\n${"-".repeat(72)}\n${text || "(no license text shipped with the package)"}`,
  );
}
for (const [name, text, license] of FONTKIT_INLINED) {
  const full = completeLicense(name, license, text);
  const tag = license ? `${license}, ` : "";
  blocks.push(
    `${name} (${tag}inlined in @pdf-lib/fontkit's UMD build)\n${"-".repeat(72)}\n${full}`,
  );
}
blocks.push(
  `PDFium and the libraries compiled into dist/pdfium.wasm (BSD-3-Clause / Apache-2.0 PDFium; FreeType, libjpeg-turbo, OpenJPEG, Little CMS, libpng, zlib, AGG 2.3, fast_float, dragonbox)\n${"-".repeat(72)}\nSee licenses/PDFium-LICENSE.txt and licenses/PDFium-third-party.txt.\nThis software is based in part on the work of the Independent JPEG Group.\nPortions of this software are copyright The FreeType Project (www.freetype.org). All rights reserved.`,
  `Inter (font, SIL Open Font License 1.1)\n${"-".repeat(72)}\nSee licenses/Inter-OFL.txt.`,
  `DejaVu Sans (font, Bitstream Vera / DejaVu license)\n${"-".repeat(72)}\nSee licenses/DejaVu-LICENSE.txt.`,
);

writeFileSync(
  join(HERE, "THIRD_PARTY_NOTICES"),
  `@fenfill/mcp ${pkg.version} bundles the following third-party software.\n\n${blocks.join("\n\n\n")}\n`,
);

// ---- size report -------------------------------------------------------------------------
const outBytes = statSync(join(DIST, "index.js")).size;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const own = Object.entries(Object.values(result.metafile.outputs)[0].inputs)
  .filter(([p]) => !p.includes("node_modules"))
  .reduce((s, [, i]) => s + i.bytesInOutput, 0);
const byPkg = new Map();
for (const [id, b] of sizes) byPkg.set(id, (byPkg.get(id) ?? 0) + b);
const top = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
process.stderr.write(
  `built dist/index.js ${kb(outBytes)} (own code ${kb(own)}) + dist/pdfium.wasm ${kb(wasmBytes.length)} (sha256 ${wasmSha}); largest: ${top
    .map(([id, b]) => `${id} ${kb(b)}`)
    .join(", ")}\n`,
);
if (!existsSync(join(DIST, "fonts", "Inter-Regular.ttf"))) throw new Error("fonts missing");
for (const f of ["PDFium-LICENSE.txt", "PDFium-third-party.txt"]) {
  if (!existsSync(join(HERE, "licenses", f))) throw new Error(`licenses/${f} missing`);
}
