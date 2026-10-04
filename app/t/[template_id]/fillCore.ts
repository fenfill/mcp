// The Node-safe stamping core: schema normalization → marks → stamped PDF.
//
// This barrel is the ONE surface the @fenfill/mcp package bundles, so an agent's
// local fill runs the exact code the browser runs.
// Everything reachable from here must stay free of React, stores, Supabase,
// pdfjs and DOM globals at import time — eslint.config.mjs pins the imports and
// fillCore.node.test.ts stamps a real PDF with `fetch`/`document` unavailable.
//
// Browser call sites keep importing the modules directly (FillForm's
// characterization tests mock "./stampPdf" by path); only out-of-app consumers
// go through this file. Outside a browser, pass `fonts` (and `logoBytes`) to
// stampPdf — its relative-URL fetch fallback only resolves on the web origin.

export {
  type AgentCell,
  type AgentColumn,
  agentEntries,
  type AgentEntry,
  type AgentFieldType,
  type AgentSkip,
  type AgentType,
  type AgentValuesResult,
  fillAgentPdf,
  type FillAgentPdfArgs,
  type FillAgentPdfResult,
  hasInfoTag,
  type LoadImage,
  mapAgentValues,
  MCP_OUTPUT_TAG,
  prefilledAcroFieldCount,
} from "./agentValues";
export {
  bucketRows,
  buildFieldById,
  choiceKey,
  expBodyRows,
  expKey,
  expLayout,
  fieldKey,
  MULTI_SEP,
  resolveMembers,
  splitMulti,
} from "./fillKeys";
export { buildMarks, type BuildMarksArgs } from "./fillMarks";
export { normalizeSchema } from "./normalizeSchema";
export { type Mark, type Placement, type StampOptions, stampPdf } from "./stampPdf";
