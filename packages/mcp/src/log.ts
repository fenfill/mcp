// stderr-only logging. stdout carries the MCP JSON-RPC stream, so nothing else
// may ever be written there (the bundle banner also reroutes console.log).
//
// PRIVACY: a log line carries ONLY a fixed message and scalar metadata the
// caller picks from a short, safe vocabulary: tool names, job ids, statuses,
// error codes, counts and durations. Never a tool argument (paths included) and
// never a fill value. The metadata type admits scalars only, so a whole args
// object can't be dumped by accident.

export type LogMeta = Record<string, string | number | boolean | null>;

type Sink = (line: string) => void;

const stderrSink: Sink = (line) => {
  try {
    process.stderr.write(line);
  } catch {
    // A closed stderr must never crash the server.
  }
};

let sink: Sink = stderrSink;

/** Tests capture log output here. */
export function setLogSink(next: Sink | null): void {
  sink = next ?? stderrSink;
}

function fmt(meta: LogMeta | undefined): string {
  if (!meta) return "";
  let out = "";
  for (const k of Object.keys(meta)) out += ` ${k}=${String(meta[k])}`;
  return out;
}

export function log(level: "info" | "warn" | "error", msg: string, meta?: LogMeta): void {
  const line = `[fenfill-mcp] ${level} ${msg}${fmt(meta)}\n`;
  sink(line);
}
