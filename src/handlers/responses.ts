/**
 * Handler: /v1/responses — OpenAI Responses API (Codex CLI compatibility).
 *
 * Mirrors Python server.py _handle_responses():
 *  - Converts Responses API input format to internal messages
 *  - Supports tool calling + function_call_output
 *  - SSE event stream for streaming mode
 */

import type { RouteContext } from "../router";
import { jsonOK, jsonError, parseBody, resolveRequestModel } from "../router";
import { messagesToPrompt, parseToolCalls } from "../tools";
import { generate } from "../gemini";
import { uploadImages } from "../multimodal";
import { log } from "../utils/log";
import { sseResponse } from "../utils/sse";
import { usage } from "../utils/response";

export async function handleResponses(ctx: RouteContext): Promise<Response> {
  const body = await parseBody(ctx.request);
  if (!body) return jsonError("invalid JSON", 400);

  const req = body as Record<string, unknown>;
  const resolved = resolveRequestModel(body as { model?: string }, ctx.cfg, log);
  if ("error" in resolved) return resolved.error;

  const { name: modelName, modeId, thinkMode } = resolved.model;

  // Convert Responses API input to OpenAI messages
  // eslint-disable-next-line prefer-const
  let messages: { role: string; content: string; tool_calls?: unknown[]; name?: string; tool_call_id?: string }[] = [];

  // Instructions → system message
  const instructions = req.instructions as string | undefined;
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  // Input items → messages
  // eslint-disable-next-line prefer-const
  let inputItems = req.input;
  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (typeof item === "object" && item !== null) {
        const it = item as Record<string, unknown>;
        // function_call_output → tool result
        if (it.type === "function_call_output") {
          messages.push({
            role: "tool",
            tool_call_id: (it.call_id as string) ?? "",
            name: (it.name as string) ?? "",
            content: (it.output as string) ?? "",
          });
        }
        // assistant message with function calls
        else if ((it.role === "assistant" || (it.type === "message" && it.role === "assistant"))) {
          const contentParts = it.content as unknown[] | undefined;
          let textAcc = "";
          const tcList: { id: string; type: string; function: { name: string; arguments: string } }[] = [];

          if (Array.isArray(contentParts)) {
            for (const cp of contentParts) {
              const cpObj = cp as Record<string, unknown>;
              if (cpObj.type === "output_text") textAcc += (cpObj.text as string) ?? "";
              else if (cpObj.type === "function_call") {
                tcList.push({
                  id: (cpObj.call_id as string) ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                  type: "function",
                  function: {
                    name: (cpObj.name as string) ?? "",
                    arguments: (cpObj.arguments as string) ?? "{}",
                  },
                });
              }
            }
          } else if (typeof contentParts === "string") {
            textAcc = contentParts;
          }

          const msg: { role: string; content: string | null; tool_calls?: unknown[] } = {
            role: "assistant",
            content: textAcc || null,
          };
          if (tcList.length > 0) msg.tool_calls = tcList;
          messages.push(msg);
        }
        // user / other roles
        else {
          let content = "";
          const rawContent = it.content;
          if (typeof rawContent === "string") content = rawContent;
          else if (Array.isArray(rawContent)) {
            content = (rawContent as Record<string, unknown>[])
              .filter((c) => c.type === "text" || c.type === "input_text")
              .map((c) => c.text ?? "")
              .join(" ");
          }
          messages.push({ role: (it.role as string) ?? "user", content });
        }
      }
    }
  }

  const tools = req.tools as unknown[] | undefined;
  const toolChoice = req.tool_choice as string | undefined;
  const stream = req.stream === true;

  const { prompt, images } = messagesToPrompt(
    messages as Parameters<typeof messagesToPrompt>[0],
    tools as Parameters<typeof messagesToPrompt>[1],
    toolChoice as Parameters<typeof messagesToPrompt>[2],
  );

  if (!prompt.trim()) return jsonError("empty input", 400);

  const fileRefs = await uploadImages(images, ctx.cfg);

  try {
    let text = await generate(prompt, modeId, thinkMode, ctx.cfg, fileRefs ?? undefined);

    let tcResult: ReturnType<typeof parseToolCalls> | undefined;
    if (tools && text && toolChoice !== "none") {
      tcResult = parseToolCalls(text);
      text = tcResult.clean;
    }

    const rid = `resp_${crypto.randomUUID().slice(0, 16)}`;
    const mid = `msg_${crypto.randomUUID().slice(0, 12)}`;

    const output: Record<string, unknown>[] = [];
    if (tcResult?.toolCalls?.length) {
      for (const tc of tcResult.toolCalls) {
        output.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: "completed",
        });
      }
    }
    if (text || !tcResult?.toolCalls?.length) {
      output.push({
        type: "message",
        id: mid,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: text ?? "", annotations: [] }],
      });
    }

    const respObj = {
      id: rid,
      object: "response",
      status: "completed",
      model: modelName,
      output,
      usage: {
        input_tokens: Math.floor(prompt.length / 4),
        output_tokens: Math.floor((text ?? "").length / 4),
        total_tokens: Math.floor((prompt.length + (text ?? "").length) / 4),
      },
    };

    if (stream) {
      const { response, writer } = sseResponse();
      const encoder = new TextEncoder();

      (async () => {
        try {
          // response.created
          const created = {
            type: "response.created",
            response: { id: rid, object: "response", status: "in_progress", model: modelName, output: [] },
          };
          await writer.write(encoder.encode(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`));

          for (const item of output) {
            if (item.type === "function_call") {
              const ev = {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              };
              await writer.write(encoder.encode(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(ev)}\n\n`));
            } else if (item.type === "message") {
              const contentArr = item.content as { type: string; text: string }[];
              for (const cp of contentArr) {
                const ev = {
                  type: "response.output_text.done",
                  item_id: item.id,
                  content_index: (contentArr as unknown[]).indexOf(cp),
                  text: cp.text,
                };
                await writer.write(encoder.encode(`event: response.output_text.done\ndata: ${JSON.stringify(ev)}\n\n`));
              }
            }
          }

          const completed = { type: "response.completed", response: respObj };
          await writer.write(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`));
        } catch (e) {
          log(`Responses stream error: ${e}`);
        } finally {
          await writer.close().catch(() => {});
        }
      })();

      return response;
    }

    return jsonOK(respObj);
  } catch (e) {
    return jsonError(`upstream error: ${e}`, 502);
  }
}
