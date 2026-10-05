// The web editor's wand / snap engine is not published (founder decision,
// 2026-10-05): none of its modules may enter this package's bundle graph. The
// package's snap uses its own rule finder (src/rules.ts). The mirror export
// (scripts/mcp-public/export.mjs) refuses them too.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG, "../..");

/** Editor modules that must never be bundled (basename, without extension). */
export const UNPUBLISHED = ["smartSnap", "lineSnap", "detectionImage", "areaSlice"];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package from node_modules
  const stem = base.replace(/\.js$/, "");
  for (const c of [stem + ".ts", stem + ".tsx", base, join(stem, "index.ts")]) {
    if (existsSync(c) && !c.endsWith("/")) return c;
  }
  return null;
}

/** Every source file reachable from `entry` through static and dynamic imports. */
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const r = resolveImport(f, m[1]);
      if (r && !seen.has(r)) todo.push(r);
    }
  }
  return seen;
}

describe("bundle graph", () => {
  it("never reaches the editor's wand/snap modules", () => {
    const files = [...graph(join(PKG, "src/index.ts"))].map((f) => relative(ROOT, f));
    // Sanity: the walk does follow `@/` imports into the stamping core.
    expect(files).toContain("app/t/[template_id]/fillCore.ts");
    const hits = files.filter((f) =>
      UNPUBLISHED.some((m) => f.endsWith(`/${m}.ts`) || f.endsWith(`/${m}.tsx`)),
    );
    expect(hits).toEqual([]);
  });
});
