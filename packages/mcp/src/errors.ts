// One error type for everything a tool reports back to the agent: a stable
// `code` (the /v1 code when the API produced it), a human message and an
// actionable hint. Tool handlers turn it into an `isError` result.

export class ToolError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { hint?: string; status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.details = opts.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    for (const [k, v] of Object.entries(this.details)) if (v !== undefined) out[k] = v;
    return out;
  }
}

/** An unexpected throw, as a ToolError. The message is passed through to the agent
 * (who sent the arguments) but is never logged. */
export function asToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const message = e instanceof Error && e.message ? e.message : "Unexpected error.";
  return new ToolError("internal_error", message, {
    hint: "This is a bug in fenfill-mcp or an unreadable file. Try again; if it persists, use the fenfill web app.",
  });
}
