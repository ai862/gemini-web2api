/**
 * Gemini StreamGenerate protocol core.
 *
 * Mirrors Python gemini.py — builds f.req payload, handles SAPISID auth,
 * fetches Gemini's StreamGenerate endpoint, and parses wrb.fr response lines.
 *
 * Key differences from Python:
 *  - SHA-1 via Web Crypto API (async)
 *  - Cookie from env (not filesystem)
 *  - fetch() instead of urllib/httpx
 *  - No proxy — Workers runs on CF global network
 *  - Always supports streaming (no httpx opt-in)
 */

import type { RuntimeConfig } from "./config";
import { log } from "./utils/log";

// ─── Cookie helpers ──────────────────────────────────────────────────────

interface CookieData {
  str: string;
  sapisid: string | null;
}

function parseCookieJson(json: string): CookieData {
  const data = JSON.parse(json);
  const cookieStr = data.cookie ?? "";
  const sapisid = data.sapisid ?? null;
  return { str: cookieStr, sapisid };
}

function parseCookieText(text: string): CookieData {
  const pairs: Record<string, string> = {};
  for (const part of text.split("; ")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx !== -1) {
      pairs[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  return { str: text, sapisid: pairs["SAPISID"] ?? null };
}

export function loadCookie(cfg: RuntimeConfig): CookieData {
  const raw = cfg.cookieJson;
  if (!raw) return { str: "", sapisid: null };
  try {
    if (raw.startsWith("{")) {
      return parseCookieJson(raw);
    }
    return parseCookieText(raw);
  } catch (e) {
    log(`Cookie parse error: ${e}`);
    return { str: "", sapisid: null };
  }
}

/**
 * Generate SAPISIDHASH auth header using Web Crypto API (SHA-1).
 */
export async function makeSapisidHash(sapisid: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts} ${sapisid} https://gemini.google.com`;
  const enc = new TextEncoder().encode(payload);
  const hashBuf = await crypto.subtle.digest("SHA-1", enc);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

// ─── f.req payload builder ───────────────────────────────────────────────

/**
 * Build the f.req URL-encoded payload for StreamGenerate.
 *
 * inner[0]   = [prompt, 0, None, file_refs, None, None, 0]   — user prompt
 * inner[1]   = ["en"]                                          — language
 * inner[17]  = [[think_mode]]                                  — thinking depth
 * inner[59]  = uuid                                            — session id
 * inner[79]  = model_id                                        — model mode (1-6)
 *
 * All other indices are fixed sentinel values reverse-engineered
 * from the Gemini frontend JS source.
 */
export function buildPayload(
  prompt: string,
  modelId: number,
  thinkMode: number,
  fileRefs?: string[],
  extraFields?: Record<number, unknown>
): string {
  const inner: unknown[] = new Array(102).fill(null);

  inner[0] = fileRefs
    ? [prompt, 0, null, fileRefs.map((r) => [null, null, r]), null, null, 0]
    : [prompt, 0, null, null, null, null, 0];

  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;

  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      inner[Number(k)] = v;
    }
  }

  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

// ─── URL builder ─────────────────────────────────────────────────────────

export function getGeminiUrl(cfg: RuntimeConfig): string {
  const reqid = Math.floor(Date.now() / 1000) % 1_000_000;
  return (
    "https://gemini.google.com/_/BardChatUi/data/" +
    "assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${cfg.geminiBl}&hl=en&_reqid=${reqid}&rt=c`
  );
}

export function getProcessFileUrl(cfg: RuntimeConfig): string {
  const reqid = Math.floor(Date.now() / 1000) % 1_000_000;
  return (
    "https://gemini.google.com/_/BardChatUi/data/" +
    "assistant.lamda.BardFrontendService/ProcessFile" +
    `?bl=${cfg.geminiBl}&hl=en&_reqid=${reqid}&rt=c`
  );
}

// ─── Request headers ─────────────────────────────────────────────────────

export async function buildHeaders(
  cfg: RuntimeConfig
): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://gemini.google.com",
    Referer: "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  const cookie = loadCookie(cfg);
  if (cookie.str) h["Cookie"] = cookie.str;
  if (cookie.sapisid) {
    h["Authorization"] = await makeSapisidHash(cookie.sapisid);
  }

  return h;
}

// ─── Response parsing ────────────────────────────────────────────────────

/**
 * Extract text strings from a single wrb.fr response line.
 *
 * Response format:
 *   ["wrb.fr", ..., [null, "...[\"...\", ..., [[\"text content\"]]]"]]
 */
export function extractTextsFromLine(line: string): string[] {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line) as unknown[];
    const innerStr = (arr[0] as unknown[])[2] as string | undefined;
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr) as unknown[];
    if (!Array.isArray(inner) || inner.length < 5 || !inner[4]) return [];

    const parts = inner[4] as unknown[];
    const texts: string[] = [];
    for (const part of parts) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1] as unknown[]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch {
    return [];
  }
}

/**
 * Parse full wrb.fr response into final text.
 */
export function extractResponseText(raw: string): string {
  let lastText = "";
  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

/**
 * Clean Gemini response text — strip code reference markers.
 */
export function cleanText(text: string): string {
  return text
    .replace(
      /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs,
      ""
    )
    .replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "")
    .trim();
}

// ─── Streaming helper — async generator from Gemini response ─────────────

/**
 * Parse wrb.fr lines incrementally, yielding text deltas.
 *
 * This is the streaming equivalent of extractResponseText().
 * Used by generateStream() but also directly accessible for custom flows.
 */
export function* parseStreamingLines(lines: string[]): Generator<string> {
  let prevText = "";
  for (const line of lines) {
    const texts = extractTextsFromLine(line);
    for (const t of texts) {
      if (t.length > prevText.length) {
        const delta = cleanText(t.slice(prevText.length));
        if (delta) yield delta;
        prevText = t;
      }
    }
  }
}

// ─── Main Gemini fetch functions ─────────────────────────────────────────

/**
 * Non-streaming generation — send f.req POST, return full response text.
 * Implements retry logic matching Python's generate().
 */
export async function generate(
  prompt: string,
  modelId: number,
  thinkMode: number,
  cfg: RuntimeConfig,
  fileRefs?: string[],
  extraFields?: Record<number, unknown>
): Promise<string> {
  const url = getGeminiUrl(cfg);
  const headers = await buildHeaders(cfg);
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < cfg.retryAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(cfg.requestTimeoutSec * 1000),
      });
      const raw = await resp.text();
      return extractResponseText(raw);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < cfg.retryAttempts - 1) {
        log(`Retry ${attempt + 1}/${cfg.retryAttempts}: ${lastErr.message}`);
        await sleepMs(cfg.retryDelaySec * 1000);
      }
    }
  }
  throw lastErr ?? new Error("generate failed");
}

/**
 * Streaming generation — async generator yielding text deltas.
 * Uses fetch() ReadableStream to incrementally wrb.fr lines.
 */
export async function* generateStream(
  prompt: string,
  modelId: number,
  thinkMode: number,
  cfg: RuntimeConfig,
  fileRefs?: string[],
  extraFields?: Record<number, unknown>
): AsyncGenerator<string> {
  const url = getGeminiUrl(cfg);
  const headers = await buildHeaders(cfg);
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < cfg.retryAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(cfg.requestTimeoutSec * 1000),
      });

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buf = "";
      let prevText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        while (buf.includes("\n")) {
          const nlIdx = buf.indexOf("\n");
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 1);

          const texts = extractTextsFromLine(line);
          for (const t of texts) {
            if (t.length > prevText.length) {
              const delta = cleanText(t.slice(prevText.length));
              if (delta) yield delta;
              prevText = t;
            }
          }
        }
      }
      return; // success — exit retry loop
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < cfg.retryAttempts - 1) {
        log(`Stream retry ${attempt + 1}/${cfg.retryAttempts}: ${lastErr.message}`);
        await sleepMs(cfg.retryDelaySec * 1000);
      }
    }
  }
  throw lastErr ?? new Error("generateStream failed");
}

// ─── Utility ─────────────────────────────────────────────────────────────

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
