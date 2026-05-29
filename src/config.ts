/**
 * Configuration — reads from Worker Env bindings.
 *
 * Mirrors Python config.py but uses environment variables / wrangler secrets
 * instead of JSON files.
 */

import type { Env } from "./types";

export interface RuntimeConfig {
  port: number;             // informational only (Workers uses CF route)
  host: string;
  retryAttempts: number;
  retryDelaySec: number;
  requestTimeoutSec: number;
  geminiBl: string;
  defaultModel: string;
  logRequests: boolean;
  cookieFile: string | null; // not used on Workers — see cookieJson
  proxy: string | null;     // not needed — Workers has global network access
  /** JSON-stringified cookie data: {"cookie":"...","sapisid":"..."} */
  cookieJson: string | null;
  apiKeys: string[];
}

export function buildConfig(env: Env): RuntimeConfig {
  return {
    port: 8081,
    host: "0.0.0.0",
    retryAttempts: 3,
    retryDelaySec: 2,
    requestTimeoutSec: 180,
    geminiBl: env.GEMINI_BL || "boq_assistant-bard-web-server_20260525.09_p0",
    defaultModel: env.DEFAULT_MODEL || "gemini-3.5-flash",
    logRequests: env.LOG_REQUESTS !== "false",
    cookieFile: null,
    proxy: null,
    cookieJson: env.COOKIE_JSON || null,
    apiKeys: env.API_KEYS
      ? env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
      : [],
  };
}
