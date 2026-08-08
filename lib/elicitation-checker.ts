// ─── Shared facilitator-checker transport (modules 1 & 3; future modules 2 & 4) ────────────────
//
// One implementation of the checker call so the two (soon four) endpoints cannot drift: the
// Anthropic request with a HARD timeout (a hung checker must never push a completed, paid
// analysis past the serverless kill line), robust JSON extraction (code fences and trailing
// commas survive — the old indexOf("{") slice silently discarded real findings), the
// deterministic findings gate (lib/elicitation), and the fail-open health markers.
//
// Health-marker contract (§1.5): silence always means "did not run"; a clean review says so out
// loud; and a response whose findings were ALL rejected at the gate is reported as gate failure,
// never as a clean review (8/8 code-review finding: a fully-gated-away response rendered as
// "no findings" — a false all-clear).

import { parseJsonLoose } from "./extractJson";
import { validateElicitationFindings, type ElicitationFinding } from "./elicitation";
import { callClaudeWithSearch } from "./claudeSearch";

export const CHECKER_MODEL = "claude-sonnet-4-6";
export const CHECKER_MAX_TOKENS = 1200;
// Hard per-call timeout. The checker is display-only prose; 25s of extra latency is the most it
// is allowed to cost, and on timeout the catch fail-opens to the UNREVIEWED marker.
export const CHECKER_TIMEOUT_MS = 25_000;
// Skip the checker entirely when the handler has already burned most of its 300s serverless
// budget on the primary call + retries — never risk a 504 for an audit footnote.
export const CHECKER_DEADLINE_MS = 200_000;

// Search-mode timeout is looser (web_search rounds take longer) but still hard-capped: a checker
// must never push a completed paid analysis toward the serverless kill line.
export const CHECKER_SEARCH_TIMEOUT_MS = 60_000;

export async function runElicitationChecker(opts: {
  apiKey: string | undefined;
  prompt: string;               // the full facilitator prompt (subject + digest + criteria)
  allowedQuantities: string[];  // gate whitelist for finding.quantity
  subjectLabel: string;         // e.g. "the elicited quantities" / "the revenue rationales"
  handlerStartMs?: number;      // Date.now() at handler entry — enables the deadline skip
  // External-facts grounding: when set, the checker runs through callClaudeWithSearch with this
  // many web searches so it can VERIFY factual claims (trial outcomes, cited results) instead of
  // only auditing internal coherence. Off by default (API frugality) — enable per checker.
  maxSearches?: number;
}): Promise<{ findings: ElicitationFinding[]; flags: string[] }> {
  const unreviewed = (why: string): { findings: ElicitationFinding[]; flags: string[] } => ({
    findings: [{ severity: "info", message: `AI checker ${why} — ${opts.subjectLabel} are UNREVIEWED` }],
    flags: [],
  });
  if (!opts.apiKey) return unreviewed("unavailable this run (no API key; fail-open)");
  if (opts.handlerStartMs != null && Date.now() - opts.handlerStartMs > CHECKER_DEADLINE_MS) {
    return unreviewed("skipped this run (serverless time budget nearly exhausted; fail-open)");
  }
  try {
    let ctext: string;
    if (opts.maxSearches && opts.maxSearches > 0) {
      // Grounded mode: the search helper owns transport; a hard race caps the added latency
      // (the underlying call may still settle later — the fail-open marker has already answered).
      ctext = await Promise.race([
        callClaudeWithSearch({
          anthropicKey: opts.apiKey,
          system: "You are a rigorous elicitation FACILITATOR with web search. Verify factual claims before judging them; respond ONLY with the requested STRICT JSON.",
          userMessage: opts.prompt,
          maxTokens: CHECKER_MAX_TOKENS,
          maxSearches: opts.maxSearches,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`grounded checker exceeded ${CHECKER_SEARCH_TIMEOUT_MS / 1000}s`)), CHECKER_SEARCH_TIMEOUT_MS)),
      ]);
    } else {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: CHECKER_MODEL,
          max_tokens: CHECKER_MAX_TOKENS,
          messages: [{ role: "user", content: opts.prompt }],
        }),
        signal: AbortSignal.timeout(CHECKER_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[elicitation-checker] HTTP ${res.status}: ${body.slice(0, 300)}`);
        return unreviewed(`unavailable this run (HTTP ${res.status}; fail-open)`);
      }
      const cd = (await res.json()) as { content?: { type: string; text?: string }[] };
      ctext = (cd.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    }
    const gated = validateElicitationFindings(parseJsonLoose(ctext).value, opts.allowedQuantities);
    if (gated.findings.length) return gated;
    if (gated.flags.length) {
      // The checker DID respond but everything was rejected at the gate — not a clean review.
      return {
        findings: [{
          severity: "medium",
          message: `AI checker responded but its output failed the format gate (${gated.flags.length} item${gated.flags.length > 1 ? "s" : ""} dropped: ${gated.flags[0]}) — ${opts.subjectLabel} are effectively UNREVIEWED this run`,
        }],
        flags: gated.flags,
      };
    }
    return { findings: [{ severity: "info", message: `AI checker reviewed ${opts.subjectLabel} — no findings` }], flags: [] };
  } catch (e) {
    console.error("[elicitation-checker] failed (fail-open):", (e as Error)?.message);
    return unreviewed("unavailable this run (fail-open)");
  }
}
