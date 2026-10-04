// The package version. build.mjs injects it with esbuild `define`; under vitest
// (unbundled) the identifier is undeclared, and `typeof` keeps that safe.
declare const __FENFILL_MCP_VERSION__: string | undefined;

export const VERSION: string =
  typeof __FENFILL_MCP_VERSION__ === "string" ? __FENFILL_MCP_VERSION__ : "0.0.0-dev";

export const USER_AGENT = `fenfill-mcp/${VERSION}`;
