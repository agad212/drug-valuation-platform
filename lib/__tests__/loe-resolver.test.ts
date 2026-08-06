import { describe, it, expect } from "vitest";
import {
  resolveLoe, P_PROTECTIVE_DEFAULT, TERM_ODE, TERM_NCE, TERM_BPCIA,
  PTE_EFFECTIVE_LIFE_CAP_YEARS,
} from "../loe-resolver";

describe("LOE resolver — statutory exclusivity floor", () => {
  it("orphan (7yr) governs over NCE (5yr) for the valued indication", () => {
    const r = resolveLoe({ approvalYear: 2031, exclusivity: { isNCE: true, orphanConfirmedForIndication: true } });
    expect(r.exclusivityFloorYear).toBe(2031 + TERM_ODE); // 2038, not 2036
    expect(r.exclusivityTerm).toMatch(/orphan/);
  });

  it("biologic 12yr governs, and is NOT extended by a second indication's 3-yr term", () => {
    const r = resolveLoe({ approvalYear: 2030, exclusivity: { isBiologic: true, newClinicalInvestigation: true } });
    expect(r.exclusivityFloorYear).toBe(2030 + TERM_BPCIA); // 2042 — the 3-yr does not stack
  });

  it("QIDP (+5) and pediatric (+6mo) STACK on top of the governing term", () => {
    const r = resolveLoe({ approvalYear: 2030, exclusivity: { isNCE: true, qidp: true, pediatricExclusivity: true } });
    expect(r.exclusivityFloorYear).toBe(Math.round(2030 + TERM_NCE + 5 + 0.5)); // 2041 (40.5 → rounds)
    expect(r.exclusivityTerm).toMatch(/QIDP/);
    expect(r.exclusivityTerm).toMatch(/pediatric/);
  });

  it("no exclusivity basis emitted → labeled NCE default + FLAG (never a silent assumption)", () => {
    const r = resolveLoe({ approvalYear: 2030, exclusivity: {} });
    expect(r.exclusivityFloorYear).toBe(2035);
    expect(r.exclusivityTerm).toMatch(/ASSUMED/);
    expect(r.flags.join(" ")).toMatch(/not emitted/);
  });
});

describe("LOE resolver — patents", () => {
  it("THE TALADEGIB CASE: a compound patent expiring BEFORE approval cannot protect and is PTE-ineligible", () => {
    // COM US9000023 expires ~2029; approval ~2031. The patent is commercially moot; ODE governs.
    const r = resolveLoe({
      approvalYear: 2031,
      exclusivity: { isNCE: true, orphanConfirmedForIndication: true },
      patents: [{ id: "US9000023", type: "compound", expiryYear: 2029, coversValuedIndication: true, pteEligible: true }],
    });
    expect(r.patentCeilingYear).toBeNull();
    expect(r.flags.join(" ")).toMatch(/expires 2029 BEFORE approval 2031/);
    expect(r.flags.join(" ")).toMatch(/PTE-ineligible/);
    // Single exclusivity case at 2038 — NOT the 2036 the launch+5 fallback produced.
    expect(r.cases).toHaveLength(1);
    expect(r.expectedLoeYear).toBe(2038);
    expect(r.cases[0].basis).toBe("exclusivity");
  });

  it("a method-of-use patent past the floor produces WEIGHTED cases, not a point (skinny-label risk)", () => {
    const r = resolveLoe({
      approvalYear: 2031,
      exclusivity: { isNCE: true, orphanConfirmedForIndication: true }, // floor 2038
      patents: [{ id: "AU2021360767A1", type: "method-of-use", expiryYear: 2041, coversValuedIndication: true }],
    });
    const p = P_PROTECTIVE_DEFAULT["method-of-use"]; // 0.30
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0]).toMatchObject({ loeYear: 2041, weight: p, basis: "patent" });
    expect(r.cases[1]).toMatchObject({ loeYear: 2038, weight: 1 - p, basis: "exclusivity" });
    expect(r.expectedLoeYear).toBe(Math.round(0.3 * 2041 + 0.7 * 2038)); // 2039
    expect(r.flags.join(" ")).toMatch(/skinny label/);
  });

  it("a patent NOT covering the valued indication is excluded + flagged", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "WO-other", type: "compound", expiryYear: 2045, coversValuedIndication: false }],
    });
    expect(r.patentCeilingYear).toBeNull();
    expect(r.expectedLoeYear).toBe(2035);
    expect(r.flags.join(" ")).toMatch(/does not cover the valued indication/);
  });

  it("PTE adds up to 5yr but is clipped by the §156 14-yr effective-life cap", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-com", type: "compound", expiryYear: 2042, coversValuedIndication: true, pteEligible: true }],
    });
    // 2042 + 5 = 2047, but the cap is 2030 + 14 = 2044.
    expect(r.patentCeilingYear).toBe(2030 + PTE_EFFECTIVE_LIFE_CAP_YEARS);
    expect(r.flags.join(" ")).toMatch(/14-yr effective-life cap/);
  });

  it("pediatric exclusivity extends the PATENT ceiling too, not just the exclusivity floor", () => {
    // Per FDA: the 6-month period "is added to all existing PATENTS and exclusivity on all applications held
    // by the sponsor for that active moiety" — so it rides on top of the patent term (and of PTE), not only
    // the statutory floor. Control below proves the assertion discriminates.
    const withPed = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true, pediatricExclusivity: true },
      patents: [{ id: "US-com", type: "compound", expiryYear: 2042, coversValuedIndication: true }],
    });
    const noPed = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-com", type: "compound", expiryYear: 2042, coversValuedIndication: true }],
    });
    expect(noPed.patentCeilingYear).toBe(2042);
    expect(withPed.patentCeilingYear).toBe(2043);        // +6mo on the patent, rounded
    expect(noPed.exclusivityFloorYear).toBe(2035);
    expect(withPed.exclusivityFloorYear).toBe(2036);     // +6mo on the floor as well
  });

  it("an UNSOURCED pProtective override is not trusted — held at the type default + flagged", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-mou", type: "method-of-use", expiryYear: 2044, coversValuedIndication: true, pProtective: 0.95 }],
    });
    expect(r.cases[0].weight).toBeCloseTo(P_PROTECTIVE_DEFAULT["method-of-use"], 6); // 0.30, not 0.95
    expect(r.flags.join(" ")).toMatch(/UNSOURCED/);
    // …and WITH a rationale it is trusted.
    const ok = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-mou", type: "method-of-use", expiryYear: 2044, coversValuedIndication: true, pProtective: 0.75, pProtectiveRationale: "no non-patented indication exists to skinny-label into" }],
    });
    expect(ok.cases[0].weight).toBeCloseTo(0.75, 6);
  });

  it("the strongest-protection patent governs, and a compound patent carries a higher weight than an MOU", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [
        { id: "US-mou", type: "method-of-use", expiryYear: 2041, coversValuedIndication: true },
        { id: "US-com", type: "compound", expiryYear: 2043, coversValuedIndication: true },
      ],
    });
    expect(r.patentCeilingYear).toBe(2043);
    expect(r.cases[0].weight).toBeCloseTo(P_PROTECTIVE_DEFAULT.compound, 6); // 0.90
  });
});

describe("LOE resolver — public statements", () => {
  it("a SOURCED public LOE anchors (single case)", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true }, // floor 2035
      patents: [{ id: "US-com", type: "compound", expiryYear: 2038, coversValuedIndication: true }],
      publicStatements: [{ statedYear: 2037, source: "EvaluatePharma", quote: "LOE 2037" }],
    });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]).toMatchObject({ loeYear: 2037, basis: "public-statement", weight: 1 });
  });

  it("a public LOE BELOW the statutory floor is raised to the floor + flagged (it cannot undercut statute)", () => {
    // The live taladegib run carried an 'LOE ~2026' citation — plainly impossible pre-approval.
    const r = resolveLoe({
      approvalYear: 2031,
      exclusivity: { orphanConfirmedForIndication: true }, // floor 2038
      publicStatements: [{ statedYear: 2026, source: "HCPLive" }],
    });
    expect(r.expectedLoeYear).toBe(2038);
    expect(r.flags.join(" ")).toMatch(/BELOW the statutory exclusivity floor/);
  });

  it("a ≥3yr divergence from the patent/exclusivity view is flagged as possibly stale", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-com", type: "compound", expiryYear: 2045, coversValuedIndication: true }],
      publicStatements: [{ statedYear: 2036, source: "an analyst note" }],
    });
    expect(r.flags.join(" ")).toMatch(/diverges ≥3yr/);
  });

  it("an UNCITED public statement is ignored (no source → not trusted)", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      publicStatements: [{ statedYear: 2050, source: "  " }],
    });
    expect(r.expectedLoeYear).toBe(2035);
    expect(r.cases[0].basis).toBe("exclusivity");
  });

  it("among several sourced statements the most CONSERVATIVE wins (no cherry-picking upside)", () => {
    const r = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      publicStatements: [
        { statedYear: 2044, source: "bullish note" },
        { statedYear: 2039, source: "conservative note" },
      ],
    });
    expect(r.cases[0].loeYear).toBe(2039);
  });
});

describe("LOE resolver — case distribution integrity", () => {
  it("weights always sum to 1 and every case carries a basis + rationale", () => {
    for (const input of [
      { approvalYear: 2031, exclusivity: { orphanConfirmedForIndication: true } },
      { approvalYear: 2031, exclusivity: { isNCE: true }, patents: [{ id: "p", type: "method-of-use" as const, expiryYear: 2045, coversValuedIndication: true }] },
      { approvalYear: 2031, exclusivity: { isBiologic: true }, publicStatements: [{ statedYear: 2049, source: "src" }] },
    ]) {
      const r = resolveLoe(input);
      expect(r.cases.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 9);
      for (const c of r.cases) {
        expect(c.rationale.length).toBeGreaterThan(0);
        expect(["patent", "exclusivity", "public-statement"]).toContain(c.basis);
      }
      expect(r.provenance.length).toBeGreaterThan(0);
    }
  });
});
