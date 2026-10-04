// Environment configuration. Split in two on purpose: fill_form reads ONLY the
// cache location (it never touches the network, and never even reads the API
// key), while the network tools read the API settings on use. A missing key
// therefore breaks only the tools that need it.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ToolError } from "./errors.js";

export type Env = Record<string, string | undefined>;

export const DEFAULT_API_URL = "https://api.fenfill.com";
export const DEFAULT_WAIT_SECONDS = 50;
const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 600;

export interface ApiConfig {
  apiKey: string;
  apiUrl: string; // origin (+ optional path prefix), no trailing slash
}

const KEY_RE = /^ff_live_[A-Za-z0-9_-]{20,200}$/;

/** The OS per-user cache directory + `fenfill-mcp`. */
export function defaultCacheDir(env: Env = process.env, platform = process.platform): string {
  const home = homedir();
  if (platform === "darwin") return join(home, "Library", "Caches", "fenfill-mcp");
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(base, "fenfill-mcp", "Cache");
  }
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".cache");
  return join(base, "fenfill-mcp");
}

export function cacheDirFromEnv(env: Env = process.env): string {
  const raw = env.FENFILL_CACHE_DIR?.trim();
  if (!raw) return defaultCacheDir(env);
  return resolve(expandHome(raw));
}

export function waitSecondsFromEnv(env: Env = process.env): number {
  const raw = env.FENFILL_ANALYZE_WAIT_SECONDS?.trim();
  if (!raw) return DEFAULT_WAIT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, n));
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** Validated FENFILL_API_URL: https, or http only on a loopback host. */
export function apiUrlFromEnv(env: Env = process.env): string {
  const raw = env.FENFILL_API_URL?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("invalid_config", "FENFILL_API_URL is not a valid URL.", {
      hint: `Unset it to use ${DEFAULT_API_URL}.`,
    });
  }
  const httpOk = url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !httpOk) {
    throw new ToolError(
      "invalid_config",
      "FENFILL_API_URL must use https (http only for localhost).",
      {
        hint: `Unset it to use ${DEFAULT_API_URL}.`,
      },
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ToolError(
      "invalid_config",
      "FENFILL_API_URL must be a plain origin, without credentials, query or fragment.",
      { hint: `Unset it to use ${DEFAULT_API_URL}.` },
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The API settings, for the network tools only. */
export function apiConfigFromEnv(env: Env = process.env): ApiConfig {
  const apiUrl = apiUrlFromEnv(env);
  const apiKey = env.FENFILL_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new ToolError("missing_api_key", "FENFILL_API_KEY is not set.", {
      hint: "Create a key in fenfill (Settings → API keys) and pass it to this MCP server as FENFILL_API_KEY. fill_form works without one.",
    });
  }
  if (!KEY_RE.test(apiKey)) {
    throw new ToolError("invalid_api_key", "FENFILL_API_KEY doesn't look like a fenfill API key.", {
      hint: "Keys start with ff_live_. Copy it again from fenfill (Settings → API keys).",
    });
  }
  return { apiKey, apiUrl };
}

/** `~` / `~/…` → the home directory. Anything else is returned unchanged. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}
