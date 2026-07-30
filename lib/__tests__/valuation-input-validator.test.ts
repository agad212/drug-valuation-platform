import { describe, it, expect } from "vitest";
import { validateValuationInputs, applyValidatedUpdates, WRITABLE_FIELDS } from "../valuation-input-validator";
import type { Valuation } from "../types";

describe("valuation-input-validator — accepts valid inputs, rejects out-of-range (never clamps, never sets)", () => {
  it("accepts in-range values", () => {
    const { accepted, rejected } = validateValuationInputs({
      discountRate: 0.12, cogsPct: 0, taxRate: 0.21, workingCapitalPct: 0.1,
      peakSales: 2e9, devCostPV: 3e8, launchYear: 2030, loeYear: 2040, ptrs: 0.2,
      phase: "Phase 2", asset: "Foo", sponsor: "Bar",
    });
    expect(rejected).toHaveLength(0);
    expect(accepted.discountRate).toBe(0.12);
    expect(accepted.cogsPct).toBe(0); // cost-rate fields allow 0
    expect(accepted.peakSales).toBe(2e9);
    expect(accepted.launchYear).toBe(2030);
    expect(accepted.phase).toBe("Phase 2");
  });

  it("rejects out-of-range rates / money / years (surfaced, not set)", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ discountRate: 1.5 }, "discountRate"],
      [{ discountRate: 0 }, "discountRate"], // strictly (0,1)
      [{ ptrs: 0 }, "ptrs"],
      [{ ptrs: 1 }, "ptrs"],
      [{ peakSales: -100 }, "peakSales"],
      [{ launchYear: 1800 }, "launchYear"],
      [{ launchYear: 2030.5 }, "launchYear"], // non-integer
      [{ phase: "Phase 9" }, "phase"],
    ];
    for (const [upd, field] of cases) {
      const { accepted, rejected } = validateValuationInputs(upd);
      expect(accepted[field]).toBeUndefined();
      expect(rejected.some((r) => r.field === field)).toBe(true);
    }
  });

  it("NO-WRITABLE-ENGINE-OUTPUT: pApproval / eNPV / revenuePV / rnpv / roi are dropped as not-writable", () => {
    const { accepted, rejected } = validateValuationInputs({
      pApproval: 0.9, eNPV: 1200, eNPVM: 1200, revenuePV: 5e9, rnpv: 3e9, roi: 12,
    });
    expect(Object.keys(accepted)).toHaveLength(0);
    for (const f of ["pApproval", "eNPV", "eNPVM", "revenuePV", "rnpv", "roi"]) {
      expect(rejected.some((r) => r.field === f && /not a writable field/.test(r.reason))).toBe(true);
    }
    // and none of those are in the whitelist
    for (const f of ["pApproval", "eNPV", "revenuePV", "rnpv", "roi"]) {
      expect((WRITABLE_FIELDS as readonly string[]).includes(f)).toBe(false);
    }
  });
});

describe("valuation-input-validator — applyValidatedUpdates reproduces the panel setters' side-effects", () => {
  const base: Valuation = {
    peakSales: 1e9, discountRate: 0.12, launchYear: 2030, loeYear: 2043, loeBasis: "patent",
    indications: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  };

  it("peakSales routes to the FIRST indication (matches the chat setter)", () => {
    const next = applyValidatedUpdates(base, { peakSales: 5e8 });
    expect(next.indications![0].peakSales).toBe(5e8);
    expect(next.indications![1].peakSales).toBeUndefined(); // only the first
  });

  it("a loeYear set CLEARS loeBasis (matches the panel's LOE setter)", () => {
    const next = applyValidatedUpdates(base, { loeYear: 2041 });
    expect(next.loeYear).toBe(2041);
    expect(next.loeBasis).toBeUndefined();
  });

  it("a non-side-effect field is a plain merge", () => {
    const next = applyValidatedUpdates(base, { discountRate: 0.1 });
    expect(next.discountRate).toBe(0.1);
    expect(next.loeBasis).toBe("patent"); // untouched
  });
});
