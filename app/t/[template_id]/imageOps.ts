// Shared pure image-pixel ops (no DOM, no network). Used by the detection image
// (smart-snap floodfill) and the signature upload pipeline (adaptive background
// knockout). Kept dependency-free so both can be unit-tested without a canvas.

// RGBA -> luminance buffer. Transparent pixels (alpha < 16) read as white (255)
// so they behave like background. Luminance weights mirror pxLum in smartSnap.ts.
export function toGray(data: Uint8ClampedArray, W: number, H: number): Uint8Array {
  const g = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] =
      data[p + 3] < 16 ? 255 : (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
  }
  return g;
}

// Grow-only scratch for the horizontal pass, reused across calls to cut GC
// pressure on multi-page docs (four full-page Float32Array temps were churned
// per detection build). SAFE because boxMean is fully synchronous and JS is
// single-threaded within a realm: no two boxMean calls ever interleave, and the
// worker bundle and the main-thread bundle each get their own module instance
// (separate realms), so there is no cross-thread sharing of this buffer. The
// buffer is fully overwritten (indices [0, W*H)) before it is read, so a larger
// stale buffer from a previous page leaves no readable residue.
let hScratch = new Float32Array(0);

// Exact box mean (radius r) via two separable prefix-sum passes. Edge windows
// divide by their real (clamped) pixel count, so borders aren't darkened by the
// implicit zero-padding a naive blur would add. O(W*H) per scale.
//
// `out` (optional): a caller-owned buffer to write the result into instead of
// allocating a fresh one. It must be distinct per concurrently-read result (the
// horizontal-pass scratch above is shared, but each result buffer is not). When
// `out` is too small it is ignored and a fresh array is allocated. Output values
// are bit-identical whether or not `out`/pooling is used — the accumulation
// order is unchanged and the shared scratch is fully rewritten each call.
export function boxMean(
  gray: Uint8Array,
  W: number,
  H: number,
  r: number,
  out?: Float32Array,
): Float32Array {
  const n = W * H;
  // Horizontal sums into `h` (Float32 holds up to (2r+1)*255 easily).
  if (hScratch.length < n) hScratch = new Float32Array(n);
  const h = hScratch;
  const prefix = new Float32Array(W + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) prefix[x + 1] = prefix[x] + gray[row + x];
    for (let x = 0; x < W; x++) {
      const lo = x - r > 0 ? x - r : 0;
      const hi = x + r < W - 1 ? x + r : W - 1;
      h[row + x] = prefix[hi + 1] - prefix[lo];
    }
  }
  // Vertical sums over `h`, then divide by the 2-D window's real pixel count.
  const result = out && out.length >= n ? out : new Float32Array(n);
  const col = new Float32Array(H + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) col[y + 1] = col[y] + h[y * W + x];
    const wxLo = x - r > 0 ? x - r : 0;
    const wxHi = x + r < W - 1 ? x + r : W - 1;
    const wCols = wxHi - wxLo + 1;
    for (let y = 0; y < H; y++) {
      const lo = y - r > 0 ? y - r : 0;
      const hi = y + r < H - 1 ? y + r : H - 1;
      result[y * W + x] = (col[hi + 1] - col[lo]) / (wCols * (hi - lo + 1));
    }
  }
  return result;
}
