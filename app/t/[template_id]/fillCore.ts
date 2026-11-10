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
  checkTagIds,
  FENFILL_OUTPUT_TAG,
  fillAgentPdf,
  type FillAgentPdfArgs,
  type FillAgentPdfResult,
  FILLED_OUTPUT_TAGS,
  hasInfoTag,
  type LoadImage,
  mapAgentValues,
  MCP_OUTPUT_TAG,
  MIN_VALUE_PREFIX,
  nestedIdOwners,
  type NestedOwner,
  prefilledAcroFieldCount,
  prefixHits,
  UnsupportedScriptError,
  type UserMarkup,
  userMarkupCount,
} from "./agentValues";
export {
  bucketRows,
  buildFieldById,
  choiceKey,
  expBodyRows,
  expKey,
  expLayout,
  fieldKey,
  flowKey,
  MULTI_SEP,
  resolveMembers,
  splitMulti,
} from "./fillKeys";
export { buildMarks, type BuildMarksArgs } from "./fillMarks";
export { JP_FACE_BYTES, JP_FACE_SHA256 } from "./fontRuns";
export { normalizeSchema } from "./normalizeSchema";
export {
  distributeFlow,
  distributeParts,
  type FlowMember,
  flowMemberOf,
  flowMembers,
  type FlowOptions,
  type FlowOverflow,
  type FlowPage,
  type FlowResult,
  flowSplitBoxes,
  joinSplit,
  parseParts,
  type PartsGroup,
  partsMembers,
  type PartsParse,
  type SplitWrite,
  stampFlowMeasure,
} from "./splitFill";
export { stampAdvanceMeasure } from "./stampAdvances";
export { type Mark, type Placement, type StampOptions, stampPdf } from "./stampPdf";
