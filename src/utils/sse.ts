/**
 * SSE (Server-Sent Events) streaming utilities for Workers.
 *
 * Workers cannot write chunked responses directly like Python's wfile.write().
 * Instead, we use Web Streams API (TransformStream) to produce SSE frames.
 */

/**
 * Create a Response with SSE headers and a writable stream.
 * The caller gets a WritableStreamDefaultWriter to push events.
 *
 * Usage:
 *   const { response, writer } = sseResponse();
 *   await writer.write(encoder.encode(`data: ${json}\n\n`));
 *   await writer.close();
 *   return response;
 */
export function sseResponse(): {
  response: Response;
  writer: WritableStreamDefaultWriter<Uint8Array>;
} {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Auto-close on write errors
  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });

  return {
    response,
    writer: {
      write(data: Uint8Array) {
        return writer.write(data);
      },
      close() {
        return writer.close();
      },
      abort(reason?: unknown) {
        return writer.abort(reason);
      },
      get ready() {
        return writer.ready;
      },
      get desiredSize() {
        return writer.desiredSize;
      },
    } as WritableStreamDefaultWriter<Uint8Array>,
  };
}

/**
 * Convenience: write a JSON SSE data frame.
 */
export async function sseWriteJson(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  data: unknown
): Promise<void> {
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

/**
 * Convenience: write a named SSE event with JSON data.
 */
export async function sseWriteEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: string,
  data: unknown
): Promise<void> {
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

/**
 * Convenience: write the SSE end-of-stream marker.
 */
export async function sseWriteDone(
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<void> {
  const encoder = new TextEncoder();
  await writer.write(encoder.encode("data: [DONE]\n\n"));
}
