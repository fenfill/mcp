// Shutdown wiring for the stdio entry point: stdin closing, the transport
// closing, SIGTERM and SIGINT all run the SAME drain (stop polling, give an
// in-flight analyze upload a moment to record its job id so the next session
// resumes it instead of paying again), then exit.
//
// The drain is best effort: MCP clients typically close stdin, wait ~2 s, then
// send SIGTERM (and later SIGKILL), so it may be cut short. A SECOND signal
// exits at once.

export interface ShutdownHost {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  stdin: { on(event: "end" | "close", listener: () => void): unknown };
  exit(code?: number): void;
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

/** Install the handlers; returns the close callback (e.g. for the transport's onclose). */
export function installShutdown(host: ShutdownHost, drain: () => Promise<void>): () => void {
  let closing = false;
  let signals = 0;
  const close = () => {
    if (closing) return;
    closing = true;
    void drain()
      .catch(() => undefined)
      .finally(() => host.exit(0));
  };
  const onSignal = (sig: keyof typeof SIGNAL_EXIT) => () => {
    signals++;
    if (signals > 1) {
      host.exit(SIGNAL_EXIT[sig]);
      return;
    }
    close();
  };
  host.on("SIGTERM", onSignal("SIGTERM"));
  host.on("SIGINT", onSignal("SIGINT"));
  host.stdin.on("end", close);
  host.stdin.on("close", close);
  return close;
}
