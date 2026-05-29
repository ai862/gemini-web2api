/**
 * Handler: /v1beta/models/{model}:generateContent — Google native API.
 *
 * Mirrors Python server.py _handle_google_generate():
 *  - Supports Google native contents format
 *  - System instructions
 *  - Tool/function calling
 *  - Stream + non-stream
 */

import type { RouteContext } from "../router";
import { jsonOK, jsonError, parseBody } from "../router";
import { googleContentsToPrompt, parseGoogleFunctionCalls } from "../tools";
import { generate, generateStream } from "../gemini";
import { uploadImages } from "../multimodal";
import { log } from "../utils/log";
import { sseResponse } from "../utils/sse";
import { resolveModel } from "../models";
import { googleUsage } from "../utils/response";

export async function handleGoogleGenerate(ctx: RouteContext): Promise<Response> {
  const body = await parseBody(ctx.request);
  if (!body) return jsonError("invalid JSON", 400);

  const req = body as Record<string, unknown>;

  // Extract model name from URL path: /v1beta/models/{model}:generateContent
  const pathMatch = ctx.url.pathname.match(/\/v1beta\/models\/([^:?]+)/);
  const modelNameInput = pathMatch ? pathMatch[1] : ctx.cfg.defaultModel;

  let resolved;
  try {
    resolved = resolveModel(modelNameInput, ctx.cfg.defaultModel, log);
  } catch (err) {
    return jsonError(String(err), 400);
  }

  const { name: modelName, modeId, thinkMode } = resolved;
  const isStream = ctx.url.pathname.includes("streamGenerateContent") || (req.stream === true);

  const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
  const toolConfig = req.toolConfig as Record<string, unknown> | undefined;
  const fcConfig = toolConfig?.functionCallingConfig as Record<string, unknown> | undefined;
  const fcMode = fcConfig?.mode as string ?? "AUTO";

  const { prompt, images } = googleContentsToPrompt(req as Parameters<typeof googleContentsToPrompt>[0]);

  if (!prompt.trim()) return jsonError("empty content", 400);

  const fileRefs = await uploadImages(images, ctx.cfg);

  log(`Google API: model=${modelName} stream=${isStream} tools=${hasTools} prompt_len=${prompt.length}`);

  // ─── Stream path (no tools) ──────────────────────────────────────
  if (isStream && (!hasTools || fcMode === "NONE")) {
    const { response, writer } = sseResponse();
    const encoder = new TextEncoder();

    (async () => {
      try {
        let fullText = "";
        for await (const delta of generateStream(prompt, modeId, thinkMode, ctx.cfg, fileRefs ?? undefined)) {
          if (!delta) continue;
          fullText += delta;
          const chunk = {
            candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }],
            modelVersion: modelName,
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        const finalChunk = {
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: googleUsage(prompt, fullText),
          modelVersion: modelName,
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      } catch (e) {
        log(`Google stream error: ${e}`);
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    return response;
  }

  // ─── Non-stream path ────────────────────────────────────────────
  try {
    let text = await generate(prompt, modeId, thinkMode, ctx.cfg, fileRefs ?? undefined);

    if (!text) {
      log("Warning: empty response from Gemini");
    }

    const responseParts: Record<string, unknown>[] = [];

    if (hasTools && text && fcMode !== "NONE") {
      const { clean, functionCalls } = parseGoogleFunctionCalls(text);
      if (functionCalls.length > 0) {
        if (clean) responseParts.push({ text: clean });
        for (const fc of functionCalls) {
          responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
        }
      } else {
        responseParts.push({ text: text ?? "I apologize, but I was unable to generate a response. Please try again." });
      }
    } else {
      responseParts.push({ text: text ?? "I apologize, but I was unable to generate a response. Please try again." });
    }

    const candidate = {
      content: { parts: responseParts, role: "model" },
      finishReason: "STOP",
      index: 0,
    };

    const responseObj = {
      candidates: [candidate],
      usageMetadata: googleUsage(prompt, text ?? ""),
      modelVersion: modelName,
    };

    // Stream (with tools — single event, matching Python behavior)
    if (isStream) {
      const { response: sseResp, writer } = sseResponse();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(`data: ${JSON.stringify(responseObj)}\n\n`));
      await writer.close().catch(() => {});
      return sseResp;
    }

    return jsonOK(responseObj);
  } catch (e) {
    return jsonError(`upstream error: ${e}`, 502);
  }
}
