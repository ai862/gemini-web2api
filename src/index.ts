/**
 * gemini-web2api — Cloudflare Worker main entry point.
 *
 * Wires together:
 *  - Router dispatch (src/router.ts)
 *  - Route registrations for all endpoints
 *  - CORS, auth, global error handling
 *
 * Routes are registered once at module init time (not per-request).
 */

import type { Env } from "./types";
import { MODELS, __version__ } from "./version";
import { registerRoute, dispatch, jsonOK, jsonError } from "./router";
import { handleChat } from "./handlers/chat";
import { handleResponses } from "./handlers/responses";
import { handleGoogleGenerate } from "./handlers/google";
import { log, setLogEnabled } from "./utils/log";

// ─── Route registration (runs once at module init) ─────────────────────

function ensureRoutes(): void {
  // Health check
  registerRoute("GET", /^\/$/, async (ctx) => {
    return jsonOK({ status: "ok", version: __version__, models: Object.keys(MODELS) });
  });

  // OpenAI model list
  registerRoute("GET", /^\/v1\/models$/, async () => {
    return jsonOK({
      object: "list",
      data: Object.entries(MODELS).map(([name, cfg]) => ({
        id: name,
        object: "model",
        created: 1_700_000_000,
        owned_by: "google",
        description: cfg.desc,
      })),
    });
  });

  // Google native model list
  registerRoute("GET", /^\/v1beta\/models$/, async () => {
    return jsonOK({
      models: Object.entries(MODELS).map(([name, cfg]) => ({
        name: `models/${name}`,
        displayName: name,
        description: cfg.desc,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
    });
  });

  // OpenAI chat completions
  registerRoute("POST", /^\/v1\/chat\/completions$/, handleChat);

  // OpenAI responses (Codex CLI)
  registerRoute("POST", /^\/v1\/responses$/, handleResponses);

  // Google native generate content (stream + non-stream)
  registerRoute("POST", /^\/v1beta\/models\/.+:generateContent$/, handleGoogleGenerate);
  registerRoute("POST", /^\/v1beta\/models\/.+:streamGenerateContent$/, handleGoogleGenerate);
}

// ─── Worker entry ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setLogEnabled(env.LOG_REQUESTS !== "false");
    ensureRoutes();

    try {
      return await dispatch(request, env);
    } catch (err) {
      log(`Unhandled error: ${err}`);
      return jsonError("internal server error", 500);
    }
  },
};
