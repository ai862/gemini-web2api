/**
 * Request router — maps URL paths to handlers.
 *
 * Mirrors the routing logic in Python server.py: do_GET / do_POST.
 * Auth check applied to all /v1/* paths.
 */

import type { Env, ResolvedModel } from "./types";
import type { RuntimeConfig } from "./config";
import { MODELS } from "./types";
import { buildConfig } from "./config";
import { resolveModel } from "./models";

// ─── Handler registry ───────────────────────────────────────────────────

export interface RouteContext {
  env: Env;
  cfg: RuntimeConfig;
  url: URL;
  request: Request;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

interface RouteEntry {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

let routes: RouteEntry[] = [];

export function registerRoute(method: string, pattern: RegExp, handler: RouteHandler): void {
  routes.push({ method, pattern, handler });
}

export function resetRoutes(): void {
  routes = [];
}

// ─── Auth ────────────────────────────────────────────────────────────────

function authorized(request: Request, cfg: RuntimeConfig): boolean {
  if (cfg.apiKeys.length === 0) return true;
  const auth = request.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : (request.headers.get("x-api-key") ?? "");
  return cfg.apiKeys.includes(key);
}

// ─── Dispatch ────────────────────────────────────────────────────────────

export async function dispatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const cfg = buildConfig(env);
  const ctx: RouteContext = { env, cfg, url, request };

  // CORS preflight — always allowed
  if (method === "OPTIONS") {
    return corsPreflightResponse();
  }

  // Auth check for all /v1/ paths
  if (url.pathname.startsWith("/v1/") && !authorized(request, cfg)) {
    return jsonError("invalid api key", 401);
  }

  // Route matching
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;
    return route.handler(ctx);
  }

  return jsonError("not found", 404);
}

// ─── Shared helpers for handlers ────────────────────────────────────────

export function corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export function jsonError(message: string, status = 400): Response {
  const body = JSON.stringify({ error: { message } });
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

export function jsonOK(data: unknown, status = 200): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

/**
 * Parse JSON request body, returning null on failure.
 */
export async function parseBody(request: Request): Promise<unknown | null> {
  try {
    const text = await request.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Resolve model from request body, with error handling.
 */
export function resolveRequestModel(
  body: { model?: string } | null,
  cfg: RuntimeConfig,
  log?: (msg: string) => void
): { model: ResolvedModel } | { error: Response } {
  if (!body) return { error: jsonOK({ error: { message: "invalid JSON" } }, 400) };
  try {
    const model = resolveModel(body.model ?? cfg.defaultModel, cfg.defaultModel, log);
    return { model };
  } catch (err) {
    return { error: jsonOK({ error: { message: String(err) } }, 400) };
  }
}

/**
 * Upload images and return file refs (or null).
 */
export async function uploadImagesSafe(
  images: { data: Uint8Array; mimeType: string }[],
  cfg: RuntimeConfig
): Promise<string[] | null> {
  if (!images || images.length === 0) return null;
  const { uploadImages } = await import("../multimodal");
  return uploadImages(images, cfg);
}
