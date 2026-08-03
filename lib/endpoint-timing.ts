// lib/endpoint-timing.ts
//
// Lightweight structured timing/status logging for the LLM endpoints, so the Vercel function logs show
// which endpoint 504s and the single- vs multi-indication rate — to CONFIRM the maxDuration raise worked
// rather than assume. Logging only: no behavior change, no inputs touched, no numbers computed. Imports
// nothing.
//
// A `start` line with no matching `end` line == the function was killed mid-call (timeout → 504). Grep
// the logs for `"tag":"endpoint-timing"`.

export function logStart(endpoint: string, extra?: Record<string, unknown>): number {
  console.log(JSON.stringify({ tag: "endpoint-timing", ev: "start", endpoint, ...extra }));
  return Date.now();
}

export function logEnd(endpoint: string, startMs: number, status: "ok" | "error", extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ tag: "endpoint-timing", ev: "end", endpoint, status, durationMs: Date.now() - startMs, ...extra }));
}
