/**
 * Minimal logging utility — mirrors Python's log() from gemini.py.
 *
 * Logs are written to Workers console (visible via `wrangler tail`).
 * Respects `LOG_REQUESTS` env flag.
 */

let _enabled = true;

export function setLogEnabled(enabled: boolean): void {
  _enabled = enabled;
}

export function log(msg: string): void {
  if (_enabled) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }
}
