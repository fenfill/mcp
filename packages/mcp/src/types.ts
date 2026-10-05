// Shapes of the /v1 wire contract that this package reads. Only what the MCP
// uses is typed; everything else passes through untouched.

export type AgentType =
  | "text"
  | "multiline"
  | "date"
  | "checkbox"
  | "signature"
  | "comb"
  | "radio"
  | "multiselect"
  | "table"
  | "table_rows";

export interface AgentEntry {
  id: string;
  type: AgentType | string;
  label: string | null;
  page: number;
  box?: { x: number; y: number; w: number; h: number };
  section: { id: string; title: string | null } | null;
  required?: boolean;
  description?: string | null;
  placeholder?: string | null;
  autofill?: string | null;
  [extra: string]: unknown;
}

export interface AgentPage {
  page: number;
  width: number;
  height: number;
  /** Saved templates only: false = this page was never analyzed (it has no
   *  fields because nothing looked, not because it has no blanks). */
  analyzed?: boolean;
}

export interface AgentSchema {
  schema_version: number;
  template_id: string | null;
  name: string | null;
  page_count: number;
  pages: AgentPage[];
  fields: AgentEntry[];
  /** A saved template's version (ISO time): the base of an optimistic save. */
  updated_at?: string;
}

/** The raw v5 render schema (`?include=render`), as loosely as the merge needs it. */
export interface RenderSchema {
  version?: number;
  pages: { page: number; [k: string]: unknown }[];
  fields: { id: string; page: number; group?: string | null; [k: string]: unknown }[];
  groups: { id: string; page?: number; members?: unknown; [k: string]: unknown }[];
  [k: string]: unknown;
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface AnalyzeAccepted {
  job_id: string;
  status: "queued";
  mode: "ai" | "acroform";
  pages: number[];
  cost: number;
  /** Free AcroForm jobs: blanks without a native field look likely. */
  extra_blanks_available?: boolean;
  /** AcroForm + detect_extra_blanks: the pages the paid vision pass covers. */
  extra_blanks?: boolean;
  extra_blanks_pages?: number[];
}

export interface JobBody {
  job_id: string;
  status: JobStatus;
  mode: "ai" | "acroform";
  phase: string | null;
  progress: number;
  pages: number[];
  cost: number;
  created_at: string;
  template_id: string | null;
  error: { code: string; message: string } | null;
  result: AgentSchema | null;
  render?: RenderSchema;
  /** Not sent by the job poll today (only the 202 carries it); read if present. */
  extra_blanks_available?: boolean;
}

/** One row of GET /v1/templates (only what the MCP reads; the rest passes through). */
export interface TemplateSummary {
  id: string;
  page_count?: number;
  /** The pages fenfill analyzed (legacy NULL expanded to every page). */
  analyzed_pages?: number[];
  [k: string]: unknown;
}

/** The re-analysis kinds of POST /v1/templates/{id}/analyze. */
export type RerunKind = "scratch" | "find" | "relabel" | "label_missing";

/** POST /v1/templates/{id}/analyze with estimate: true, 200. */
export interface RerunEstimate {
  kind: RerunKind;
  pages: number[];
  /** Scans the run would charge now. */
  cost: number;
  /** label_missing: how many of `pages` the free monthly bucket covers. */
  free_label_pages: number;
  free_label_pages_left: number;
  scans_left: number;
  /** The run would be refused with 402 insufficient_scans. */
  insufficient: boolean;
}

/** PATCH /v1/templates/{id} 200. */
export interface TemplateUpdated {
  template_id: string;
  updated_at: string;
  result: AgentSchema;
}

export interface Account {
  workspace_id: string;
  tier: string;
  scans_remaining: number;
  max_pages: number;
  max_pages_per_job: number;
  max_file_mb: number;
  branding: { logo: boolean; watermark: boolean };
}
