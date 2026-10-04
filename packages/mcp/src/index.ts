// fenfill-mcp: the stdio entry point.
//
// stdout is the JSON-RPC channel. The bundle banner reroutes console.log/info/
// debug to stderr before any module runs (pdf-lib, @cantoo/pdf-lib and fontkit
// log to stdout), and this server itself only ever writes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { installShutdown } from "./lifecycle.js";
import { log } from "./log.js";
import { createFenfillServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= 22)) {
    process.stderr.write(`fenfill-mcp needs Node.js 22 or newer (this is ${process.version}).\n`);
    process.exit(1);
  }

  const { server, shutdown } = createFenfillServer({ env: process.env });
  const transport = new StdioServerTransport();

  // stdin/transport close, SIGTERM and SIGINT: one best-effort drain, then exit
  // (a second signal exits at once).
  server.server.onclose = installShutdown(process, () => shutdown());

  await server.connect(transport);
  log("info", "started", { version: VERSION });
}

main().catch(() => {
  log("error", "failed to start");
  process.exit(1);
});
