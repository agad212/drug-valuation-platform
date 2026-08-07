import { describe, it, expect } from "vitest";
import { validateCritiques, type OptionCritique } from "../option-critic";

// The deterministic gate between the LLM critic and the UI (§1.4/§1.5): enum-checked verdict,
// id-matched to the request, length-capped display prose, FRESH objects (unknown/numeric fields
// structurally cannot survive), and every drop/trim surfaced as a flag.

const IDS = ["opt-2", "opt-4"];

describe("option-critic — validateCritiques gates the LLM response", () => {
  it("a well-formed response passes through; unknown fields are stripped by construction (no-leak)", () => {
    const raw = {
      critiques: [
        {
          optionId: "opt-4",
          verdict: "partially-supported",
          reasoning: "Kalydeco held its premium with a curative label; a symptomatic add-on rarely holds the premium AND the share.",
          leverNotes: { wac: "premium came with a curative label", share: "share comp launched into an empty field" },
          // fields the LLM might invent — must never survive the gate:
          adjustedPeakSalesM: 512,
          suggestedWac: 180000,
          confidence: 0.83,
        },
      ],
    };
    const out = validateCritiques(raw, IDS);
    expect(out.critiques).toHaveLength(1);
    const c = out.critiques[0];
    expect(c.verdict).toBe("partially-supported");
    expect(Object.keys(c).sort()).toEqual(["leverNotes", "optionId", "reasoning", "verdict"]);
    expect((c as Record<string, unknown>).adjustedPeakSalesM).toBeUndefined();
    expect(out.flags).toEqual([]);
  });

  it("accepts a bare array too", () => {
    const out = validateCritiques(
      [{ optionId: "opt-2", verdict: "supported", reasoning: "Comps exhibited the joint posture." }],
      IDS,
    );
    expect(out.critiques).toHaveLength(1);
    expect(out.critiques[0].leverNotes).toBeUndefined();
  });

  it("an invented verdict is dropped WITH a flag — never coerced to the nearest enum", () => {
    const out = validateCritiques(
      [{ optionId: "opt-2", verdict: "plausible-ish", reasoning: "..." }],
      IDS,
    );
    expect(out.critiques).toHaveLength(0);
    expect(out.flags.some((f) => f.includes("plausible-ish") && f.includes("dropped"))).toBe(true);
  });

  it("a critique for an option not in the request (dangling id) is dropped + flagged", () => {
    const out = validateCritiques(
      [{ optionId: "opt-99", verdict: "supported", reasoning: "..." }],
      IDS,
    );
    expect(out.critiques).toHaveLength(0);
    expect(out.flags.some((f) => f.includes("opt-99"))).toBe(true);
  });

  it("duplicate ids: first wins, rest dropped + flagged; empty reasoning is dropped (a verdict without an argument is not a critique)", () => {
    const out = validateCritiques(
      [
        { optionId: "opt-2", verdict: "supported", reasoning: "first" },
        { optionId: "opt-2", verdict: "unsupported", reasoning: "second" },
        { optionId: "opt-4", verdict: "unsupported", reasoning: "   " },
      ],
      IDS,
    );
    expect(out.critiques).toHaveLength(1);
    expect(out.critiques[0].reasoning).toBe("first");
    expect(out.flags.some((f) => f.includes("duplicate"))).toBe(true);
    expect(out.flags.some((f) => f.includes("no reasoning"))).toBe(true);
  });

  it("oversized prose is truncated + flagged, never silently passed through", () => {
    const out = validateCritiques(
      [{ optionId: "opt-2", verdict: "supported", reasoning: "x".repeat(3000), leverNotes: { wac: "y".repeat(700), count: 42 } }],
      IDS,
    );
    expect(out.critiques[0].reasoning.length).toBeLessThanOrEqual(1601); // cap + ellipsis
    expect(out.critiques[0].leverNotes?.wac?.length).toBeLessThanOrEqual(601);
    expect(out.critiques[0].leverNotes?.count).toBeUndefined(); // non-string lever note dropped
    expect(out.flags.filter((f) => f.includes("truncated"))).toHaveLength(2);
  });

  it("truncation backs up to the last sentence boundary — a cut never lands mid-word (the 8/7 'eligible coun…' fix)", () => {
    const sentence = "This argument is exactly forty-nine chars long ok. ";
    const out = validateCritiques(
      [{ optionId: "opt-2", verdict: "supported", reasoning: sentence.repeat(40) }], // ~2080 chars of full sentences
      IDS,
    );
    const r = out.critiques[0].reasoning;
    expect(r.length).toBeLessThanOrEqual(1601);
    expect(r.endsWith(".")).toBe(true); // whole sentences kept, no dangling fragment
  });

  it("garbage (non-array, no critiques key) yields empty + a flag — the UI just keeps the deterministic flags", () => {
    for (const garbage of [null, undefined, "supported", 7, { verdict: "supported" }]) {
      const out = validateCritiques(garbage, IDS);
      expect(out.critiques).toEqual([]);
      expect(out.flags).toHaveLength(1);
    }
  });

  it("the critique type itself carries no numeric field (structural no-leak, compile-time)", () => {
    // If someone adds a numeric field to OptionCritique this stops compiling — the §1.4 guarantee
    // is that NOTHING the critic emits can be arithmetic-ready.
    const c: OptionCritique = { optionId: "a", verdict: "supported", reasoning: "b" };
    const values = [c.optionId, c.verdict, c.reasoning, c.leverNotes?.wac, c.leverNotes?.share, c.leverNotes?.count];
    for (const v of values) expect(typeof v === "string" || v === undefined).toBe(true);
  });
});
