/**
 * JSON / CORS / error response helpers.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const;

/**
 * Send a JSON response with CORS headers.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Send an error response (OpenAI-compatible error format).
 */
export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: { message } }, status);
}

/**
 * Handle CORS preflight (OPTIONS).
 */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * Usage metadata helper (matches Python _usage()).
 */
export function usage(prompt: string, text: string) {
  const pt = Math.max(1, Math.floor(prompt.length / 4));
  const ct = Math.max(0, Math.floor((text || "").length / 4));
  return {
    prompt_tokens: pt,
    completion_tokens: ct,
    total_tokens: pt + ct,
  };
}

export function googleUsage(prompt: string, text: string) {
  return {
    promptTokenCount: Math.max(1, Math.floor(prompt.length / 4)),
    candidatesTokenCount: Math.max(0, Math.floor((text || "").length / 4)),
    totalTokenCount: Math.max(1, Math.floor((prompt.length + (text || "").length) / 4)),
  };
}
