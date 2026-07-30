import { describe, it, expect } from "vitest";
import { parseValuationCommand } from "../valuation-command-parser";
import { validateValuationInputs, applyValidatedUpdates } from "../valuation-input-validator";
import { computeOutputs } from "../cashflow";
import type { Valuation } from "../types";

// The parity proof for the conversational rearchitecture: a chat command produces the SAME valuation as
// the manual path, because it routes through the SAME state transform + the reactive computeOutputs. No
// parallel compute path exists. Each case: parse → validate → applyValidatedUpdates, then compare
// computeOutputs to the manual (panel-setter) path.

const base: Valuation = {
  peakSales: 1_000_000_000, discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
  launchYear: 2030, loeYear: 2043, loeBasis: "patent", ptrs: 0.25, devCostPV: 200_000_000, phase: "Phase 2",
  indications: [
    { id: "lead", name: "Lead", peakSales: 800_000_000, launchYear: 2030 },
    { id: "b", name: "B", peakSales: 400_000_000, launchYear: 2031 },
  ],
};

// chat path: text → the same transform the live onFieldUpdate applies
function chatPath(v: Valuation, text: string): Valuation {
  const cmd = parseValuationCommand(text)!;
  const { accepted } = validateValuationInputs(cmd.updates);
  return applyValidatedUpdates(v, accepted);
}

describe("conversational parity — chat command === manual path (byte-identical computeOutputs)", () => {
  it("'set discount rate to 12.5%' matches update('discountRate', 0.125)", () => {
    const chat = chatPath(base, "set discount rate to 12.5%");
    const panel: Valuation = { ...base, discountRate: 0.125 }; // update() is a plain field set
    expect(computeOutputs(chat)).toEqual(computeOutputs(panel));
  });

  it("a spread of non-side-effect fields is byte-identical to the plain field set", () => {
    for (const [text, patch] of [
      ["set tax rate to 18%", { taxRate: 0.18 }],
      ["set COGS to 15%", { cogsPct: 0.15 }],
      ["launch 2033", { launchYear: 2033 }],
      ["set dev cost to 350M", { devCostPV: 350_000_000 }],
    ] as [string, Partial<Valuation>][]) {
      expect(computeOutputs(chatPath(base, text))).toEqual(computeOutputs({ ...base, ...patch }));
    }
  });

  it("ptrs OVERRIDE via chat === update('ptrs', x) (supersedes governed P identically)", () => {
    expect(computeOutputs(chatPath(base, "override P to 30%"))).toEqual(computeOutputs({ ...base, ptrs: 0.3 }));
  });

  it("SIDE-EFFECT peakSales: chat routes to the first indication === the indication-table path", () => {
    const chat = chatPath(base, "set peak sales to $600M");
    // the indication-table path sets the first indication's peakSales directly
    const manual: Valuation = { ...base, indications: base.indications!.map((ind, i) => (i === 0 ? { ...ind, peakSales: 600_000_000 } : ind)) };
    expect(chat.indications![0].peakSales).toBe(600_000_000);
    expect(computeOutputs(chat)).toEqual(computeOutputs(manual));
  });

  it("SIDE-EFFECT loeYear: chat clears loeBasis === the panel LOE setter", () => {
    const chat = chatPath(base, "set LOE to 2041");
    const panel: Valuation = { ...base, loeYear: 2041, loeBasis: undefined };
    expect(chat.loeBasis).toBeUndefined();
    expect(computeOutputs(chat)).toEqual(computeOutputs(panel));
  });
});

describe("conversational parity — the validation choke point blocks a bad command (nothing set)", () => {
  it("'set discount rate to 150%' → rejected → valuation UNCHANGED", () => {
    const cmd = parseValuationCommand("set discount rate to 150%")!;
    const { accepted, rejected } = validateValuationInputs(cmd.updates);
    expect(Object.keys(accepted)).toHaveLength(0);
    expect(rejected.some((r) => r.field === "discountRate")).toBe(true);
    expect(computeOutputs(applyValidatedUpdates(base, accepted))).toEqual(computeOutputs(base)); // no change
  });
});
