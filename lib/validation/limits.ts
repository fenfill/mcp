// Dependency-free size limits shared by the template write gate
// (templateSchema.ts) and the load-time normalizer (normalizeSchema.ts).
// Kept apart from templateSchema.ts so the normalizer, which the
// @fenfill/mcp bundle includes, does not pull in zod through it.

/** A table's rows / cols cap. Mirrors schemas.py MAX_GRID_DIM. */
export const MAX_GRID_DIM = 1_000;
