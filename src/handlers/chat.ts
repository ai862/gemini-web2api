/**
 * Handler: /v1/chat/completions — OpenAI Chat Completions API.
 *
 * Mirrors Python server.py _handle_chat():
 *  - Stream and non-stream paths
 *  - Tool calling support
 *  - Image multimodal support
 */

import type { RouteContext } from "../router";
import { jsonOK, jsonError, parseBody, resolveRequestModel } from "../router";
import { messagesToPrompt, parseToolCalls } from "../tools";
import { generate, generateStream } from "../gemini";
import { uploadImages } from "../multimodal";
import { log } from "../utils/log";
import { sseResponse, sseWriteJson, sseWriteDone } from "../utils/sse";
import { usage } from "../utils/response";

export async function handleChat(ctx: RouteContext): Promise<Response> {
  const body = await parseBody(ctx.request);
  if (!body) return jsonError("invalid JSON", 400);

  const req = body as Record<string, unknown>;
  const resolved = resolveRequestModel(body as { model?: string }, ctx.cfg, log);
  if ("error" in resolved) return resolved.error;

  const { name: modelName, modeId, thinkMode } = resolved.model;
  const tools = req.tools as unknown[] | undefined;
  const toolChoice = req.tool_choice as string | undefined;

  const { prompt, images } = messagesToPrompt(
    (req.messages ?? []) as Parameters<typeof messagesToPrompt>[0],
    tools as Parameters<typeof messagesToPrompt>[1],
    toolChoice as Parameters<typeof messagesToPrompt>[2],
  );

  if (!prompt.trim()) return jsonError("empty prompt", 400);

  const stream = req.stream === true;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const cid = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;

  // Upload images if present
  const fileRefs = await uploadImages(images, ctx.cfg);

  // ─── Stream path ────────────────────────────────────────────────
  if (stream && (!hasTools || toolChoice === "none")) {
    const { response, writer } = sseResponse();
    const encoder = new TextEncoder();

    (async () => {
      try {
        for await (const delta of generateStream(prompt, modeId, thinkMode, ctx.cfg, fileRefs ?? undefined)) {
          const chunk = {
            id: cid,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        const end = {
          id: cid,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        log(`Stream error: ${e}`);
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    return response;
  }

  // ─── Non-stream path ────────────────────────────────────────────
  try {
    let text = await generate(prompt, modeId, thinkMode, ctx.cfg, fileRefs ?? undefined);

    let toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"] | undefined;
    if (hasTools && text && toolChoice !== "none") {
      const parsed = parseToolCalls(text);
      text = parsed.clean;
      toolCalls = parsed.toolCalls;
    }

    const msg: Record<string, unknown> = { role: "assistant", content: text || null };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    const finish = toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop";

    // Stream with tools (single chunk — Python also sends one SSE event)
    if (stream) {
      const { response, writer } = sseResponse();
      const encoder = new TextEncoder();
      const chunk = {
        id: cid,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, delta: msg, finish_reason: finish }],
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close().catch(() => {});
      return response;
    }

    return jsonOK({
      id: cid,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, message: msg, finish_reason: finish }],
      usage: usage(prompt, text ?? ""),
    });
  } catch (e) {
    return jsonError(`upstream error: ${e}`, 502);
  }
}
