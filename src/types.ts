/**
 * Shared type definitions for gemini-web2api Worker.
 *
 * Mirrors the Python module structure — all interfaces used
 * across multiple handlers live here.
 */

// ─── Environment Bindings (from wrangler.toml + secrets) ─────────────────

export interface Env {
  DEFAULT_MODEL: string;
  GEMINI_BL: string;
  API_KEYS: string;          // comma-separated, "" = no auth
  LOG_REQUESTS: string;      // "true" | "false"
  COOKIE_JSON?: string;      // optional: {"cookie":"...","sapisid":"..."}
}

// ─── Model Definitions ────────────────────────────────────────────────────

/** MODE_CATEGORY enum from Gemini frontend JS */
export const MODEL_MODE = {
  FAST: 1,
  THINKING: 2,
  PRO: 3,
  AUTO: 4,
  FAST_DYNAMIC_THINKING: 5,
  FLASH_LITE: 6,
} as const;

export interface ModelDef {
  mode: number;
  think: number;
  desc: string;
  /** Optional extra fields injected into the f.req payload array */
  extra?: Record<number, unknown>;
}

export const MODELS: Record<string, ModelDef> = {
  "gemini-3.5-flash":                { mode: 1, think: 4, desc: "Fast general-purpose model" },
  "gemini-3.5-flash-thinking":       { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro":                 { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced":        { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto":                     { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite":  { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite":               { mode: 6, think: 4, desc: "Lightweight fast model" },
};

// ─── Request / Response shapes ────────────────────────────────────────────

/** Parsed result of resolve_model() */
export interface ResolvedModel {
  name: string;
  modeId: number;
  thinkMode: number;
  extraFields?: Record<number, unknown>;
}

/** OpenAI Chat Completion request body (relevant fields) */
export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

/** OpenAI message */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "input_text" | "image_url" | "image";
  text?: string;
  image_url?: { url: string };
  source?: { type: string; media_type?: string; data: string };
}

export interface ToolDef {
  type?: string;
  function?: { name: string; description?: string; parameters?: unknown };
  name?: string;
  description?: string;
  parameters?: unknown;
}

export type ToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI Responses API request */
export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | { type: string; text?: string; [k: string]: unknown }[];
  call_id?: string;
  name?: string;
  output?: string;
}

/** Google native API request */
export interface GoogleGenerateRequest {
  contents?: GoogleContent[];
  tools?: GoogleTool[];
  toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
  systemInstruction?: { parts: { text: string }[] };
}

export interface GoogleContent {
  role?: string;
  parts: GooglePart[];
}

export interface GooglePart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: Record<string, unknown> };
}

export interface GoogleTool {
  functionDeclarations?: { name: string; description?: string; parameters?: unknown }[];
}

// ─── Internal helper types ────────────────────────────────────────────────

/** Parsed tool call from Gemini text output */
export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface CallbackLogFn {
  (msg: string): void;
}
