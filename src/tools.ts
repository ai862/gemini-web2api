/**
 * Message conversion and tool calling.
 *
 * Mirrors Python tools.py:
 *  - OpenAI messages → Gemini prompt text (+ image extraction)
 *  - Gemini tool_call blocks → OpenAI tool_calls format
 *  - Google native API ↔ Gemini internal format
 */

import type {
  ChatMessage,
  ContentPart,
  ParsedToolCall,
  ToolChoice,
  ToolDef,
  GoogleGenerateRequest,
  GoogleTool,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildToolChoiceInstruction(
  toolChoice: ToolChoice | undefined,
  toolDefs: { name: string }[]
): string {
  if (toolChoice === "none") {
    return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  }
  if (toolChoice === "required") {
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const fnName = toolChoice.function?.name;
    if (fnName) {
      return `\n\nIMPORTANT: You MUST call the tool "${fnName}". Do not call other tools.`;
    }
  }
  return "";
}

export function buildToolPrompt(toolDefs: { name: string; description?: string; parameters?: unknown }[]): string {
  return (
    "# Tool Use\n\n" +
    "You can call the following tools. Call format:\n" +
    "```tool_call\n" +
    '{"name": "func_name", "arguments": {...}}\n' +
    "```\n\n" +
    "When calling tools, output ONLY the tool_call block(s).\n\n" +
    `Available tools:\n${JSON.stringify(toolDefs, null, 2)}`
  );
}

function googleToolChoiceInstruction(req: GoogleGenerateRequest): string {
  const tc = req.toolConfig?.functionCallingConfig;
  if (!tc) return "";
  const mode = tc.mode ?? "AUTO";
  const allowed = tc.allowedFunctionNames ?? [];

  if (mode === "NONE") {
    return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  }
  if (mode === "ANY") {
    if (allowed.length > 0) {
      return `\n\nIMPORTANT: You MUST call one of these tools: ${allowed.map((n) => `"${n}"`).join(", ")}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

// ─── OpenAI → Gemini prompt ──────────────────────────────────────────────

/**
 * Convert OpenAI messages array to (promptString, imageByteArrays).
 *
 * Images are returned as separate arrays for upload via ProcessFile.
 * Each image entry is { data: Uint8Array, mimeType: string }.
 */
export function messagesToPrompt(
  messages: ChatMessage[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice
): { prompt: string; images: { data: Uint8Array; mimeType: string }[] } {
  const parts: string[] = [];
  const images: { data: Uint8Array; mimeType: string }[] = [];

  // Tool definitions prefix
  if (tools && toolChoice !== "none") {
    const toolDefs = tools.map((t) => {
      const fn = t.function ?? t;
      return {
        name: fn.name ?? (t.name ?? ""),
        description: fn.description ?? t.description ?? "",
        parameters: fn.parameters ?? t.parameters ?? {},
      };
    });
    if (toolDefs.length > 0) {
      const constraint = buildToolChoiceInstruction(toolChoice, toolDefs);
      parts.push(buildToolPrompt(toolDefs) + constraint);
    }
  }

  for (const msg of messages) {
    const role = msg.role;
    let content = msg.content;

    // Resolve structured content (text parts + images)
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const c of content as ContentPart[]) {
        if (c.type === "text" || c.type === "input_text") {
          textParts.push(c.text ?? "");
        } else if (c.type === "image_url") {
          const url = c.image_url?.url ?? "";
          if (url.startsWith("data:")) {
            const [header, b64] = url.includes(",") ? url.split(",", 2) : ["", url];
            const mimeMatch = header.match(/:(.*?);/);
            const mime = mimeMatch ? mimeMatch[1] : "image/png";
            images.push({ data: base64ToBytes(b64), mimeType: mime });
          } else {
            // Remote URL — flagged for download
            textParts.push(`[image: ${url}]`);
          }
        } else if (c.type === "image") {
          const src = c.source;
          if (src?.type === "base64") {
            const mime = src.media_type ?? "image/png";
            images.push({ data: base64ToBytes(src.data), mimeType: mime });
          }
        }
      }
      content = textParts.join(" ");
    }

    const text = typeof content === "string" ? content : "";

    if (role === "system") {
      parts.push(`[System instruction]: ${text}`);
    } else if (role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const tcBlocks = msg.tool_calls.map((tc) => {
          return "```tool_call\n" + JSON.stringify({
            name: tc.function.name,
            arguments: safeParseJson(tc.function.arguments ?? "{}"),
          }) + "\n```";
        });
        parts.push(`[Assistant]: ${text}\n` + tcBlocks.join("\n"));
      } else {
        parts.push(`[Assistant]: ${text}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name ?? ""}]: ${text}`);
    } else {
      parts.push(text || "");
    }
  }

  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    images,
  };
}

// ─── OpenAI tool calls from Gemini text ──────────────────────────────────

/**
 * Parse ```tool_call blocks from Gemini response text.
 * Returns (cleanText, toolCallsInOpenAIFormat).
 */
export function parseToolCalls(text: string): {
  clean: string;
  toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
} {
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  const pattern = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts: string[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, match.index));
    lastEnd = match.index + match[0].length;
    try {
      const data = JSON.parse(match[1].trim());
      toolCalls.push({
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments ?? {}),
        },
      });
    } catch {
      // skip malformed blocks
    }
  }
  cleanParts.push(text.slice(lastEnd));
  return {
    clean: cleanParts.join("").trim(),
    toolCalls,
  };
}

// ─── Google native → Gemini prompt ───────────────────────────────────────

/**
 * Convert Google native API contents/tools/systemInstruction to Gemini prompt.
 */
export function googleContentsToPrompt(req: GoogleGenerateRequest): {
  prompt: string;
  images: { data: Uint8Array; mimeType: string }[];
} {
  const parts: string[] = [];
  const images: { data: Uint8Array; mimeType: string }[] = [];
  const fcMode = req.toolConfig?.functionCallingConfig?.mode ?? "AUTO";

  const tools: GoogleTool[] | undefined = req.tools;
  const toolDefs: { name: string; description?: string; parameters?: unknown }[] = [];

  if (tools && fcMode !== "NONE") {
    for (const toolGroup of tools) {
      for (const fn of toolGroup.functionDeclarations ?? []) {
        const td: { name: string; description?: string; parameters?: unknown } = {
          name: fn.name,
          description: fn.description ?? "",
        };
        if (fn.parameters) td.parameters = fn.parameters;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts ?? [])
      .filter((p) => p.text)
      .map((p) => p.text)
      .join(" ");
    if (sysText) {
      if (toolDefs.length > 0) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length > 0) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of req.contents ?? []) {
    const role = content.role ?? "user";
    const msgParts: string[] = [];
    for (const p of content.parts ?? []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        images.push({
          data: base64ToBytes(p.inlineData.data),
          mimeType: p.inlineData.mimeType ?? "image/png",
        });
      } else if (p.functionCall) {
        msgParts.push(
          "```function_call\n" + JSON.stringify({ name: p.functionCall.name, args: p.functionCall.args ?? {} }) + "\n```"
        );
      } else if (p.functionResponse) {
        msgParts.push(
          `[Tool result for ${p.functionResponse.name}]: ${JSON.stringify(p.functionResponse.response ?? {})}`
        );
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") {
      parts.push(`[Assistant]: ${text}`);
    } else {
      parts.push(text);
    }
  }

  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    images,
  };
}

// ─── Google function calls from Gemini text ──────────────────────────────

/**
 * Parse function_call blocks from Gemini model output.
 * Handles 3 formats matching Python parse_google_function_calls().
 */
export function parseGoogleFunctionCalls(text: string): {
  clean: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
} {
  const functionCalls: { name: string; args: Record<string, unknown> }[] = [];
  let clean = text;

  // Pattern 1: ```function_call\n{...}\n```
  const pattern1 = /```function_call\s*\n([\s\S]*?)\n```/g;
  clean = clean.replace(pattern1, (_, jsonStr) => {
    try {
      const data = JSON.parse(jsonStr.trim());
      if (data.name) {
        functionCalls.push({ name: data.name, args: data.args ?? data.arguments ?? {} });
      }
    } catch { /* skip */ }
    return "";
  });

  // Pattern 2: function_call\n{...} (without backticks)
  const pattern2 = /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g;
  clean = clean.replace(pattern2, (_, jsonStr) => {
    try {
      const data = JSON.parse(jsonStr.trim());
      if (data.name) {
        functionCalls.push({ name: data.name, args: data.args ?? data.arguments ?? {} });
      }
    } catch { /* skip */ }
    return "";
  });

  // Pattern 3: raw JSON with name + args
  clean = clean.trim();
  if (functionCalls.length === 0 && clean.startsWith("{")) {
    try {
      const data = JSON.parse(clean);
      if (data.name && (data.args || data.arguments)) {
        functionCalls.push({ name: data.name, args: data.args ?? data.arguments ?? {} });
        clean = "";
      }
    } catch { /* keep as-is */ }
  }

  return { clean: clean.trim(), functionCalls };
}

// ─── Utilities ───────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf;
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
