// The two stamp faces (Inter + DejaVuSans), read from `dist/fonts/` next to the
// bundle. The directory is injectable for tests (vitest runs the sources, where
// `import.meta.url` points at src/).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "./errors.js";

export interface Fonts {
  inter: ArrayBuffer;
  deja: ArrayBuffer;
}

/** A Node Buffer as an exact ArrayBuffer (the pool makes `buf.buffer` alone wrong). */
export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function defaultFontsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "fonts");
  if (existsSync(bundled)) return bundled;
  // Running the sources (dev/tests): the app's public fonts.
  return join(here, "..", "..", "..", "public", "fonts");
}

const cache = new Map<string, Fonts>();

export function loadFonts(dir: string = defaultFontsDir()): Fonts {
  const hit = cache.get(dir);
  if (hit) return hit;
  try {
    const fonts: Fonts = {
      inter: toArrayBuffer(readFileSync(join(dir, "Inter-Regular.ttf"))),
      deja: toArrayBuffer(readFileSync(join(dir, "DejaVuSans.ttf"))),
    };
    cache.set(dir, fonts);
    return fonts;
  } catch {
    throw new ToolError("fonts_missing", "The bundled fonts could not be read.", {
      hint: "Reinstall @fenfill/mcp (npx -y @fenfill/mcp@latest).",
    });
  }
}
