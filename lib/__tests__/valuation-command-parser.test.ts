import { describe, it, expect } from "vitest";
import { parseValuationCommand } from "../valuation-command-parser";

const upd = (t: string) => parseValuationCommand(t)?.updates ?? null;

describe("valuation-command-parser — precise commands map to engine INPUTS (deterministic, no LLM)", () => {
  it("percent fields", () => {
    expect(upd("set discount rate to 12%")).toEqual({ discountRate: 0.12 });
    expect(upd("discount rate 0.1")).toEqual({ discountRate: 0.1 });
    expect(upd("set tax rate to 21%")).toEqual({ taxRate: 0.21 });
    expect(upd("set COGS to 20%")).toEqual({ cogsPct: 0.2 });
    expect(upd("set working capital to 8%")).toEqual({ workingCapitalPct: 0.08 });
  });

  it("money fields (unit-aware)", () => {
    expect(upd("set peak sales to $2B")).toEqual({ peakSales: 2e9 });
    expect(upd("peak sales 2 billion")).toEqual({ peakSales: 2e9 });
    expect(upd("set dev cost to 300M")).toEqual({ devCostPV: 3e8 });
  });

  it("year fields", () => {
    expect(upd("launch 2028")).toEqual({ launchYear: 2028 });
    expect(upd("set LOE to 2035")).toEqual({ loeYear: 2035 });
  });

  it("P(approval) override + phase", () => {
    expect(upd("override P to 20%")).toEqual({ ptrs: 0.2 });
    expect(upd("set ptrs to 0.25")).toEqual({ ptrs: 0.25 });
    expect(upd("set phase to phase 3")).toEqual({ phase: "Phase 3" });
  });

  it("echo is present and mentions no computed valuation number", () => {
    const c = parseValuationCommand("set discount rate to 12%")!;
    expect(c.echo).toMatch(/discount rate.*12/i);
  });

  it("NON-commands return null (→ routed to the conversational/LLM path)", () => {
    expect(parseValuationCommand("what drives rNPV most?")).toBeNull();
    expect(parseValuationCommand("explain PTRS")).toBeNull();       // keyword but no set-intent / number
    expect(parseValuationCommand("pembrolizumab")).toBeNull();       // bare drug name → auto-value via LLM
    expect(parseValuationCommand("make the oncology indication more conservative")).toBeNull(); // fuzzy → LLM
    expect(parseValuationCommand("")).toBeNull();
  });
});
