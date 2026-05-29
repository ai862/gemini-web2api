/**
 * Multimodal image upload via Gemini ProcessFile RPC.
 *
 * Mirrors Python multimodal.py — sends base64 image data to ProcessFile
 * endpoint and extracts the returned file reference for use in StreamGenerate.
 */

import type { RuntimeConfig } from "./config";
import { getProcessFileUrl, buildHeaders, log } from "./gemini";

/**
 * Upload an image via ProcessFile RPC.
 *
 * @returns file reference string (e.g. "//xxxxxxxxx") for use in _buildPayload fileRefs.
 */
export async function uploadImage(
  imageBytes: Uint8Array,
  filename: string,
  mimeType: string,
  cfg: RuntimeConfig
): Promise<string> {
  const b64 = bytesToBase64(imageBytes);

  // Build ProcessFile payload — same structure as Python multimodal.py
  const rk: unknown[] = new Array(11).fill(null);
  rk[1] = filename;
  rk[10] = [b64, mimeType, 1];

  const processFileReq: unknown[] = new Array(4).fill(null);
  processFileReq[0] = rk;
  processFileReq[2] = 1;
  processFileReq[3] = ["en"];

  const outer = [null, JSON.stringify(processFileReq)];
  const body = new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
  const url = getProcessFileUrl(cfg);
  const headers = await buildHeaders(cfg);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(cfg.requestTimeoutSec * 1000),
  });

  const raw = await resp.text();
  const ref = parseProcessFileResponse(raw);
  if (!ref) {
    throw new Error("Failed to extract file reference from ProcessFile response");
  }
  log(`Image uploaded: ${filename} -> ${ref.slice(0, 40)}...`);
  return ref;
}

/**
 * Parse ProcessFile response to extract file reference (dg[5]).
 */
function parseProcessFileResponse(raw: string): string | null {
  for (const line of raw.split("\n")) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const arr = JSON.parse(line) as unknown[];
      const innerStr = (arr[0] as unknown[])[2] as string | undefined;
      if (!innerStr) continue;
      const inner = JSON.parse(innerStr) as unknown[];
      if (!Array.isArray(inner) || inner.length < 1) continue;

      const dg = inner[0] as unknown[];
      if (Array.isArray(dg) && dg.length > 5) {
        const ref = dg[5];
        if (typeof ref === "string" && ref) return ref;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Upload multiple images, collecting file references.
 */
export async function uploadImages(
  imageEntries: { data: Uint8Array; mimeType: string }[],
  cfg: RuntimeConfig
): Promise<string[] | null> {
  if (!imageEntries || imageEntries.length === 0) return null;

  const refs: string[] = [];
  for (const entry of imageEntries) {
    try {
      const ref = await uploadImage(entry.data, "image.png", entry.mimeType || "image/png", cfg);
      refs.push(ref);
    } catch (e) {
      log(`Image upload failed: ${e}`);
    }
  }
  return refs.length > 0 ? refs : null;
}

/**
 * Fetch image bytes from a remote URL.
 */
export async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    log(`Image fetch failed: ${e}`);
    return null;
  }
}

// ─── Utility — Uint8Array → base64 string ───────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}
