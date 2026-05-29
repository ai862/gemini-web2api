/**
 * Model definitions and resolution.
 *
 * Mirrors Python models.py — MODE_CATEGORY enum values from Gemini frontend JS.
 * Model unknown → falls back to default (graceful compatibility).
 */

import { MODELS, type ResolvedModel } from "./types";

/**
 * Resolve model name → (name, modeId, thinkMode).
 *
 * Supports `@think=N` suffix override, e.g. "gemini-3.5-flash@think=2".
 * Unknown model names fall back to default rather than erroring.
 */
export function resolveModel(
  modelName: string,
  defaultModel = "gemini-3.5-flash",
  log?: (msg: string) => void
): ResolvedModel {
  let thinkOverride: number | null = null;
  let name = modelName;

  const atIdx = name.lastIndexOf("@think=");
  if (atIdx !== -1) {
    const thinkStr = name.slice(atIdx + 7);
    name = name.slice(0, atIdx);
    const parsed = parseInt(thinkStr, 10);
    if (isNaN(parsed)) {
      throw new Error(`Invalid think level: ${thinkStr}`);
    }
    thinkOverride = parsed;
  }

  let cfg = MODELS[name];
  if (!cfg) {
    log?.(`Unknown model '${name}', falling back to '${defaultModel}'`);
    name = defaultModel;
    cfg = MODELS[name];
  }

  return {
    name,
    modeId: cfg.mode,
    thinkMode: thinkOverride ?? cfg.think,
    extraFields: cfg.extra,
  };
}
