/**
 * gemini-web2api — Cloudflare Worker (single-file bundle)
 *
 * Converts Google Gemini's web interface into an OpenAI-compatible API.
 * Deploy: upload to Cloudflare Workers via API or Dashboard.
 *
 * @version 1.1.0
 */

// ─── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  retryAttempts: 3,
  retryDelaySec: 2,
  requestTimeoutSec: 180,
  geminiBl: "boq_assistant-bard-web-server_20260525.09_p0",
  defaultModel: "gemini-3.5-flash",
};

// ─── Model Definitions ──────────────────────────────────────────────────

const MODELS = {
  "gemini-3.5-flash":               { mode: 1, think: 4, desc: "Fast general-purpose model" },
  "gemini-3.5-flash-thinking":      { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro":                 { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced":        { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto":                    { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite":              { mode: 6, think: 4, desc: "Lightweight fast model" },
};

function resolveModel(modelName, defaultModel) {
  let thinkOverride = null;
  let name = modelName;

  const atIdx = name.lastIndexOf("@think=");
  if (atIdx !== -1) {
    const thinkStr = name.slice(atIdx + 7);
    name = name.slice(0, atIdx);
    const parsed = parseInt(thinkStr, 10);
    if (isNaN(parsed)) throw new Error("Invalid think level: " + thinkStr);
    thinkOverride = parsed;
  }

  let cfg = MODELS[name];
  if (!cfg) {
    console.log("Unknown model '" + name + "', falling back to '" + defaultModel + "'");
    name = defaultModel;
    cfg = MODELS[name];
  }

  return { name, modeId: cfg.mode, thinkMode: thinkOverride !== null ? thinkOverride : cfg.think, extraFields: cfg.extra ?? null };
}

// ─── Cookie / Auth ──────────────────────────────────────────────────────

function loadCookie(env) {
  const raw = env.COOKIE_JSON;
  if (!raw) return { str: "", sapisid: null };
  try {
    if (raw.startsWith("{")) {
      const data = JSON.parse(raw);
      return { str: data.cookie || "", sapisid: data.sapisid || null };
    }
    const pairs = {};
    for (const part of raw.split("; ")) {
      const eq = part.indexOf("=");
      if (eq !== -1) pairs[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return { str: raw, sapisid: pairs["SAPISID"] || null };
  } catch {
    return { str: "", sapisid: null };
  }
}

async function makeSapisidHash(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = ts + " " + sapisid + " https://gemini.google.com";
  const enc = new TextEncoder().encode(payload);
  const hashBuf = await crypto.subtle.digest("SHA-1", enc);
  const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return "SAPISIDHASH " + ts + "_" + hex;
}

// ─── Gemini Protocol ────────────────────────────────────────────────────

function buildGeminiUrl(bl) {
  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  return "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=" + bl + "&hl=en&_reqid=" + reqid + "&rt=c";
}

function buildProcessFileUrl(bl) {
  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  return "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile?bl=" + bl + "&hl=en&_reqid=" + reqid + "&rt=c";
}

function buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields) {
  const inner = new Array(102).fill(null);
  inner[0] = fileRefs
    ? [prompt, 0, null, fileRefs.map(r => [null, null, r]), null, null, 0]
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
  return new URLSearchParams({ "f.req": JSON.stringify([null, JSON.stringify(inner)]) }).toString();
}

async function buildHeaders(env) {
  const h = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://gemini.google.com",
    Referer: "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  const cookie = loadCookie(env);
  if (cookie.str) h["Cookie"] = cookie.str;
  if (cookie.sapisid) h["Authorization"] = await makeSapisidHash(cookie.sapisid);
  return h;
}

function extractTextsFromLine(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!Array.isArray(inner) || inner.length < 5 || !inner[4]) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch {
    return [];
  }
}

function cleanText(text) {
  return text
    .replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, "")
    .replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "")
    .trim();
}

function extractResponseText(raw) {
  let lastText = "";
  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geminiGenerate(prompt, modelId, thinkMode, env, fileRefs, extraFields) {
  const url = buildGeminiUrl(env.GEMINI_BL || DEFAULT_CONFIG.geminiBl);
  const headers = await buildHeaders(env);
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields);
  const retry = parseInt(env.RETRY_ATTEMPTS) || DEFAULT_CONFIG.retryAttempts;
  const timeout = parseInt(env.REQUEST_TIMEOUT_SEC) || DEFAULT_CONFIG.requestTimeoutSec;

  let lastErr;
  for (let attempt = 0; attempt < retry; attempt++) {
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeout * 1000) });
      const raw = await resp.text();
      return extractResponseText(raw);
    } catch (err) {
      lastErr = err;
      if (attempt < retry - 1) {
        console.log("Retry " + (attempt + 1) + "/" + retry + ": " + err.message);
        await sleepMs((parseInt(env.RETRY_DELAY_SEC) || DEFAULT_CONFIG.retryDelaySec) * 1000);
      }
    }
  }
  throw lastErr || new Error("generate failed");
}

async function* geminiGenerateStream(prompt, modelId, thinkMode, env, fileRefs, extraFields) {
  const url = buildGeminiUrl(env.GEMINI_BL || DEFAULT_CONFIG.geminiBl);
  const headers = await buildHeaders(env);
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields);
  const retry = parseInt(env.RETRY_ATTEMPTS) || DEFAULT_CONFIG.retryAttempts;
  const timeout = parseInt(env.REQUEST_TIMEOUT_SEC) || DEFAULT_CONFIG.requestTimeoutSec;

  let lastErr;
  for (let attempt = 0; attempt < retry; attempt++) {
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeout * 1000) });
      const reader = resp.body.getReader();
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
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retry - 1) {
        console.log("Stream retry " + (attempt + 1) + "/" + retry + ": " + err.message);
        await sleepMs((parseInt(env.RETRY_DELAY_SEC) || DEFAULT_CONFIG.retryDelaySec) * 1000);
      }
    }
  }
  throw lastErr || new Error("generateStream failed");
}

// ─── Image Upload (ProcessFile RPC) ─────────────────────────────────────

async function uploadImage(imageBytes, filename, mimeType, env) {
  const b64 = btoa(String.fromCharCode(...imageBytes));
  const rk = new Array(11).fill(null);
  rk[1] = filename;
  rk[10] = [b64, mimeType, 1];
  const pf = [null, JSON.stringify(rk), 1, ["en"]];
  const body = new URLSearchParams({ "f.req": JSON.stringify([null, JSON.stringify(pf)]) }).toString();
  const url = buildProcessFileUrl(env.GEMINI_BL || DEFAULT_CONFIG.geminiBl);
  const headers = await buildHeaders(env);
  const timeout = parseInt(env.REQUEST_TIMEOUT_SEC) || DEFAULT_CONFIG.requestTimeoutSec;

  const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeout * 1000) });
  const raw = await resp.text();
  const ref = parseProcessFileResponse(raw);
  if (!ref) throw new Error("Failed to extract file reference");
  return ref;
}

function parseProcessFileResponse(raw) {
  for (const line of raw.split("\n")) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr[0][2];
      if (!innerStr) continue;
      const inner = JSON.parse(innerStr);
      if (Array.isArray(inner) && inner.length > 0) {
        const dg = inner[0];
        if (Array.isArray(dg) && dg.length > 5) {
          const ref = dg[5];
          if (typeof ref === "string" && ref) return ref;
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

async function uploadImages(images, env) {
  if (!images || images.length === 0) return null;
  const refs = [];
  for (const img of images) {
    try {
      const ref = await uploadImage(img.data, "image.png", img.mimeType || "image/png", env);
      refs.push(ref);
    } catch (e) {
      console.log("Image upload failed: " + e);
    }
  }
  return refs.length > 0 ? refs : null;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ─── Message Conversion + Tool Calling ──────────────────────────────────

function buildToolPrompt(toolDefs) {
  return "# Tool Use\n\nYou can call the following tools. Call format:\n```tool_call\n{\"name\": \"func_name\", \"arguments\": {...}}\n```\n\nWhen calling tools, output ONLY the tool_call block(s).\n\nAvailable tools:\n" + JSON.stringify(toolDefs, null, 2);
}

function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];
  const images = [];

  if (tools && toolChoice !== "none") {
    const toolDefs = tools.map(t => {
      const fn = t.function || t;
      return { name: fn.name || t.name || "", description: fn.description || t.description || "", parameters: fn.parameters || t.parameters || {} };
    });
    if (toolDefs.length > 0) {
      let constraint = "";
      if (toolChoice === "none") constraint = "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
      else if (toolChoice === "required") constraint = "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
      else if (typeof toolChoice === "object" && toolChoice?.function?.name) constraint = "\n\nIMPORTANT: You MUST call the tool \"" + toolChoice.function.name + "\". Do not call other tools.";
      parts.push(buildToolPrompt(toolDefs) + constraint);
    }
  }

  for (const msg of messages) {
    const role = msg.role;
    let content = msg.content;

    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        if (c.type === "text" || c.type === "input_text") textParts.push(c.text || "");
        else if (c.type === "image_url") {
          const url = c.image_url?.url || "";
          if (url.startsWith("data:")) {
            const [header, b64] = url.includes(",") ? url.split(",", 2) : ["", url];
            const mimeMatch = header.match(/:(.*?);/);
            const mime = mimeMatch ? mimeMatch[1] : "image/png";
            images.push({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), mimeType: mime });
          }
        } else if (c.type === "image" && c.source?.type === "base64") {
          images.push({ data: Uint8Array.from(atob(c.source.data), c => c.charCodeAt(0)), mimeType: c.source.media_type || "image/png" });
        }
      }
      content = textParts.join(" ");
    }

    const text = typeof content === "string" ? content : "";

    if (role === "system") parts.push("[System instruction]: " + text);
    else if (role === "assistant") {
      if (msg.tool_calls) {
        const blocks = msg.tool_calls.map(tc => "```tool_call\n" + JSON.stringify({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }) + "\n```");
        parts.push("[Assistant]: " + text + "\n" + blocks.join("\n"));
      } else parts.push("[Assistant]: " + text);
    } else if (role === "tool") parts.push("[Tool result for " + (msg.name || "") + "]: " + text);
    else parts.push(text || "");
  }

  return { prompt: parts.filter(Boolean).join("\n\n"), images };
}

function parseToolCalls(text) {
  const toolCalls = [];
  const pattern = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts = [];
  let lastEnd = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, match.index));
    lastEnd = match.index + match[0].length;
    try {
      const data = JSON.parse(match[1].trim());
      toolCalls.push({ id: "call_" + crypto.randomUUID().slice(0, 8), type: "function", function: { name: data.name, arguments: JSON.stringify(data.arguments || {}) } });
    } catch { /* skip */ }
  }
  cleanParts.push(text.slice(lastEnd));
  return { clean: cleanParts.join("").trim(), toolCalls };
}

function googleContentsToPrompt(req) {
  const parts = [];
  const images = [];
  const fcMode = req.toolConfig?.functionCallingConfig?.mode || "AUTO";
  const toolDefs = [];
  const tools = req.tools;
  if (tools && fcMode !== "NONE") {
    for (const tg of tools) {
      for (const fn of tg.functionDeclarations || []) {
        const td = { name: fn.name, description: fn.description || "" };
        if (fn.parameters) td.parameters = fn.parameters;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || []).filter(p => p.text).map(p => p.text).join(" ");
    if (sysText) {
      parts.push(toolDefs.length > 0 ? sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoice(req) : sysText);
    }
  } else if (toolDefs.length > 0) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoice(req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) msgParts.push(p.text);
      else if (p.inlineData) images.push({ data: Uint8Array.from(atob(p.inlineData.data), c => c.charCodeAt(0)), mimeType: p.inlineData.mimeType || "image/png" });
      else if (p.functionCall) msgParts.push("```function_call\n" + JSON.stringify({ name: p.functionCall.name, args: p.functionCall.args || {} }) + "\n```");
      else if (p.functionResponse) msgParts.push("[Tool result for " + p.functionResponse.name + "]: " + JSON.stringify(p.functionResponse.response || {}));
    }
    const text = msgParts.join("\n");
    parts.push(role === "model" ? "[Assistant]: " + text : text);
  }

  return { prompt: parts.filter(Boolean).join("\n\n"), images };
}

function googleToolChoice(req) {
  const tc = req.toolConfig?.functionCallingConfig;
  if (!tc) return "";
  const mode = tc.mode || "AUTO";
  const allowed = tc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length > 0) return "\n\nIMPORTANT: You MUST call one of these tools: " + allowed.map(n => '"' + n + '"').join(", ") + ". Do not respond with text only.";
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  let clean = text;
  clean = clean.replace(/```function_call\s*\n([\s\S]*?)\n```/g, (_, jsonStr) => {
    try { const d = JSON.parse(jsonStr.trim()); if (d.name) functionCalls.push({ name: d.name, args: d.args || d.arguments || {} }); } catch { /* */ }
    return "";
  });
  clean = clean.replace(/(?:^|\n)function_call\s*\n(\{[^`]*?\})/g, (_, jsonStr) => {
    try { const d = JSON.parse(jsonStr.trim()); if (d.name) functionCalls.push({ name: d.name, args: d.args || d.arguments || {} }); } catch { /* */ }
    return "";
  });
  clean = clean.trim();
  if (functionCalls.length === 0 && clean.startsWith("{")) {
    try { const d = JSON.parse(clean); if (d.name && (d.args || d.arguments)) { functionCalls.push({ name: d.name, args: d.args || d.arguments || {} }); clean = ""; } } catch { /* */ }
  }
  return { clean: clean.trim(), functionCalls };
}

// ─── Response Helpers ───────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" },
  });
}

function errorResponse(msg, status = 400) {
  return jsonResponse({ error: { message: msg } }, status);
}

function sseStream() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  return {
    response: new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" },
    }),
    write: (data) => writer.write(encoder.encode("data: " + JSON.stringify(data) + "\n\n")),
    writeEvent: (event, data) => writer.write(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")),
    writeRaw: (str) => writer.write(encoder.encode(str)),
    close: () => writer.close(),
    abort: (e) => writer.abort(e),
  };
}

function usage(prompt, text) {
  return { prompt_tokens: Math.max(1, Math.floor(prompt.length / 4)), completion_tokens: Math.max(0, Math.floor((text || "").length / 4)), total_tokens: Math.max(1, Math.floor((prompt.length + (text || "").length) / 4)) };
}

// ─── Auth ───────────────────────────────────────────────────────────────

function authorized(request, env) {
  const keysStr = env.API_KEYS || "";
  const keys = keysStr ? keysStr.split(",").map(k => k.trim()).filter(Boolean) : [];
  if (keys.length === 0) return true;
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : (request.headers.get("x-api-key") || "");
  return keys.includes(key);
}

// ─── Handlers ───────────────────────────────────────────────────────────

async function handleChat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse("invalid JSON", 400);

  let model;
  try { model = resolveModel(body.model || env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel, env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel); }
  catch (e) { return errorResponse(e.message, 400); }

  const { prompt, images } = messagesToPrompt(body.messages || [], body.tools, body.tool_choice);
  if (!prompt.trim()) return errorResponse("empty prompt", 400);

  const stream = body.stream === true;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const cid = "chatcmpl-" + crypto.randomUUID().slice(0, 12);
  const fileRefs = await uploadImages(images, env);

  // Streaming (no tools)
  if (stream && (!hasTools || body.tool_choice === "none")) {
    const sse = sseStream();
    (async () => {
      try {
        for await (const delta of geminiGenerateStream(prompt, model.modeId, model.thinkMode, env, fileRefs, model.extraFields)) {
          await sse.write({ id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
        }
        await sse.write({ id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        await sse.writeRaw("data: [DONE]\n\n");
      } catch (e) { console.log("Stream error: " + e); }
      finally { await sse.close().catch(() => {}); }
    })();
    return sse.response;
  }

  // Non-stream
  try {
    let text = await geminiGenerate(prompt, model.modeId, model.thinkMode, env, fileRefs, model.extraFields);
    let toolCalls;
    if (hasTools && text && body.tool_choice !== "none") {
      const parsed = parseToolCalls(text);
      text = parsed.clean;
      toolCalls = parsed.toolCalls;
    }

    const msg = { role: "assistant", content: text || null };
    if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
    const finish = toolCalls?.length > 0 ? "tool_calls" : "stop";

    if (stream) {
      const sse = sseStream();
      await sse.write({ id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, delta: msg, finish_reason: finish }] });
      await sse.writeRaw("data: [DONE]\n\n");
      await sse.close().catch(() => {});
      return sse.response;
    }

    return jsonResponse({ id: cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: msg, finish_reason: finish }], usage: usage(prompt, text || "") });
  } catch (e) {
    return errorResponse("upstream error: " + e, 502);
  }
}

async function handleResponses(request, env) {
  const req = await request.json().catch(() => null);
  if (!req) return errorResponse("invalid JSON", 400);

  let model;
  try { model = resolveModel(req.model || env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel, env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel); }
  catch (e) { return errorResponse(e.message, 400); }

  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  const inputItems = req.input;
  if (typeof inputItems === "string") messages.push({ role: "user", content: inputItems });
  else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") messages.push({ role: "user", content: item });
      else if (item && typeof item === "object") {
        if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          let textAcc = "";
          const tcList = [];
          const cp = item.content;
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c.type === "output_text") textAcc += c.text || "";
              else if (c.type === "function_call") tcList.push({ id: c.call_id || "call_" + crypto.randomUUID().slice(0, 8), type: "function", function: { name: c.name || "", arguments: c.arguments || "{}" } });
            }
          } else if (typeof cp === "string") textAcc = cp;
          const msg = { role: "assistant", content: textAcc || null };
          if (tcList.length > 0) msg.tool_calls = tcList;
          messages.push(msg);
        } else {
          let content = "";
          if (typeof item.content === "string") content = item.content;
          else if (Array.isArray(item.content)) content = item.content.filter(c => c.type === "text" || c.type === "input_text").map(c => c.text || "").join(" ");
          messages.push({ role: item.role || "user", content });
        }
      }
    }
  }

  const { prompt, images } = messagesToPrompt(messages, req.tools, req.tool_choice);
  if (!prompt.trim()) return errorResponse("empty input", 400);

  const fileRefs = await uploadImages(images, env);

  try {
    let text = await geminiGenerate(prompt, model.modeId, model.thinkMode, env, fileRefs);
    let tcResult;
    if (req.tools && text && req.tool_choice !== "none") {
      tcResult = parseToolCalls(text);
      text = tcResult.clean;
    }

    const rid = "resp_" + crypto.randomUUID().slice(0, 16);
    const mid = "msg_" + crypto.randomUUID().slice(0, 12);
    const output = [];

    if (tcResult?.toolCalls?.length) {
      for (const tc of tcResult.toolCalls) {
        output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
      }
    }
    if (text || !tcResult?.toolCalls?.length) {
      output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
    }

    const stream = req.stream === true;
    if (stream) {
      const sse = sseStream();
      (async () => {
        try {
          await sse.writeEvent("response.created", { type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: model.name, output: [] } });
          for (const item of output) {
            if (item.type === "function_call") await sse.writeEvent("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments });
            else if (item.type === "message") {
              for (const cp of item.content) await sse.writeEvent("response.output_text.done", { type: "response.output_text.done", item_id: item.id, content_index: item.content.indexOf(cp), text: cp.text });
            }
          }
          const respObj = { id: rid, object: "response", status: "completed", model: model.name, output, usage: usage(prompt, text || "") };
          await sse.writeEvent("response.completed", { type: "response.completed", response: respObj });
        } catch (e) { console.log("Responses stream error: " + e); }
        finally { await sse.close().catch(() => {}); }
      })();
      return sse.response;
    }

    return jsonResponse({ id: rid, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: model.name, output, usage: usage(prompt, text || "") });
  } catch (e) {
    return errorResponse("upstream error: " + e, 502);
  }
}

async function handleGoogle(request, env, url) {
  const req = await request.json().catch(() => null);
  if (!req) return errorResponse("invalid JSON", 400);

  const pathMatch = url.pathname.match(/\/v1beta\/models\/([^:?]+)/);
  const modelNameInput = pathMatch ? pathMatch[1] : (env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel);
  let model;
  try { model = resolveModel(modelNameInput, env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel); }
  catch (e) { return errorResponse(e.message, 400); }

  const isStream = url.pathname.includes("streamGenerateContent");
  const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
  const fcMode = req.toolConfig?.functionCallingConfig?.mode || "AUTO";

  const { prompt, images } = googleContentsToPrompt(req);
  if (!prompt.trim()) return errorResponse("empty content", 400);

  const fileRefs = await uploadImages(images, env);

  // Streaming
  if (isStream && (!hasTools || fcMode === "NONE")) {
    const sse = sseStream();
    (async () => {
      try {
        let fullText = "";
        for await (const delta of geminiGenerateStream(prompt, model.modeId, model.thinkMode, env, fileRefs, model.extraFields)) {
          if (!delta) continue;
          fullText += delta;
          await sse.write({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: model.name });
        }
        await sse.write({ candidates: [{ finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: Math.max(1, Math.floor(prompt.length / 4)), candidatesTokenCount: Math.max(0, Math.floor(fullText.length / 4)), totalTokenCount: Math.max(1, Math.floor((prompt.length + fullText.length) / 4)) }, modelVersion: model.name });
      } catch (e) { console.log("Google stream error: " + e); }
      finally { await sse.close().catch(() => {}); }
    })();
    return sse.response;
  }

  // Non-stream
  try {
    let text = await geminiGenerate(prompt, model.modeId, model.thinkMode, env, fileRefs, model.extraFields);
    const responseParts = [];

    if (hasTools && text && fcMode !== "NONE") {
      const { clean, functionCalls } = parseGoogleFunctionCalls(text);
      if (functionCalls.length > 0) {
        if (clean) responseParts.push({ text: clean });
        for (const fc of functionCalls) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
      } else {
        responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
      }
    } else {
      responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
    }

    const responseObj = {
      candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: Math.max(1, Math.floor(prompt.length / 4)), candidatesTokenCount: Math.max(0, Math.floor((text || "").length / 4)), totalTokenCount: Math.max(1, Math.floor((prompt.length + (text || "").length) / 4)) },
      modelVersion: model.name,
    };

    if (isStream) {
      const sse = sseStream();
      await sse.write(responseObj);
      await sse.close().catch(() => {});
      return sse.response;
    }
    return jsonResponse(responseObj);
  } catch (e) {
    return errorResponse("upstream error: " + e, 502);
  }
}

// ─── Router ──────────────────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" } });

  // Auth
  if (url.pathname.startsWith("/v1/") && !authorized(request, env)) return errorResponse("invalid api key", 401);

  try {
    // Health check
    if (method === "GET" && url.pathname === "/") return jsonResponse({ status: "ok", version: "1.1.0", models: Object.keys(MODELS) });

    // OpenAI model list
    if (method === "GET" && url.pathname === "/v1/models") return jsonResponse({
      object: "list", data: Object.entries(MODELS).map(([name, cfg]) => ({ id: name, object: "model", created: 1700000000, owned_by: "google", description: cfg.desc })),
    });

    // Google model list
    if (method === "GET" && url.pathname === "/v1beta/models") return jsonResponse({
      models: Object.entries(MODELS).map(([name, cfg]) => ({ name: "models/" + name, displayName: name, description: cfg.desc, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] })),
    });

    // Chat completions
    if (method === "POST" && url.pathname === "/v1/chat/completions") return handleChat(request, env);

    // Responses (Codex CLI)
    if (method === "POST" && url.pathname === "/v1/responses") return handleResponses(request, env);

    // Google generate (stream + non-stream)
    if (method === "POST" && url.pathname.match(/\/v1beta\/models\/.+/)) return handleGoogle(request, env, url);

    return errorResponse("not found", 404);
  } catch (err) {
    console.log("Unhandled error: " + err);
    return errorResponse("internal server error", 500);
  }
}

// ─── Worker Entry ───────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
