import { describe, it, expect } from "vitest";
import {
  resolveLoe, patentsFromKeyPatents, publicStatementsFromMarketIntel,
  P_PROTECTIVE_DEFAULT, P_PROTECTIVE_BAND,
  TERM_ODE, TERM_NCE, TERM_BPCIA, PTE_EFFECTIVE_LIFE_CAP_YEARS,
} from "../loe-resolver";
import { computeLoeYear } from "../financial-pins";

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
    // …and WITH a rationale it is trusted. (Value changed 0.75 → 0.55 when the per-type plausibility band
    // landed: 0.75 is outside the method-of-use band 0.10–0.60 and now clamps to 0.60, which is the band
    // working as intended. The assertion's INTENT — a rationale-backed override is USED rather than
    // discarded — is unchanged and still tested; the clamp has its own dedicated test in the adapter block.)
    const ok = resolveLoe({
      approvalYear: 2030,
      exclusivity: { isNCE: true },
      patents: [{ id: "US-mou", type: "method-of-use", expiryYear: 2044, coversValuedIndication: true, pProtective: 0.55, pProtectiveRationale: "no non-patented indication exists to skinny-label into" }],
    });
    expect(ok.cases[0].weight).toBeCloseTo(0.55, 6);
    expect(ok.cases[0].weight).not.toBeCloseTo(P_PROTECTIVE_DEFAULT["method-of-use"], 6); // not the default
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

describe("patentsFromKeyPatents adapter (/api/patents shape)", () => {
  it("prefers baseExpiry over estimatedExpiry so PTE is computed here, not by the LLM", () => {
    const { patents } = patentsFromKeyPatents([
      { number: "US1", type: "compound", baseExpiry: 2040, estimatedExpiry: 2045 },
    ]);
    expect(patents[0]).toMatchObject({ id: "US1", type: "compound", expiryYear: 2040, pteEligible: true });
  });

  it("falls back to estimatedExpiry with a DOUBLE-COUNT flag when baseExpiry is absent", () => {
    const { patents, flags } = patentsFromKeyPatents([
      { number: "US2", type: "method-of-use", baseExpiry: null, estimatedExpiry: 2044 },
    ]);
    expect(patents[0]).toMatchObject({ expiryYear: 2044, pteEligible: false }); // no further PTE applied
    expect(flags.join(" ")).toMatch(/double-count risk/);
  });

  it("maps process → other, and skips entries with no number or no usable expiry (flagged)", () => {
    const { patents, flags } = patentsFromKeyPatents([
      { number: "US3", type: "process", baseExpiry: 2035 },
      { number: "", type: "compound", baseExpiry: 2050 },
      { number: "US4", type: "compound", baseExpiry: null, estimatedExpiry: null },
    ]);
    expect(patents).toHaveLength(1);
    expect(patents[0].type).toBe("other");
    expect(flags.join(" ")).toMatch(/no patent number/);
    expect(flags.join(" ")).toMatch(/no usable expiry/);
    expect(flags.join(" ")).toMatch(/process patent treated as/);
  });

  it("honours an explicit scope boolean; absent scope is flagged and treated as covering", () => {
    const { patents, flags } = patentsFromKeyPatents([
      { number: "US-ipf", type: "method-of-use", baseExpiry: 2041, coversValuedIndication: true },
      { number: "US-other", type: "method-of-use", baseExpiry: 2044, coversValuedIndication: false },
      { number: "US-unk", type: "compound", baseExpiry: 2039 },
    ]);
    expect(patents[0].coversValuedIndication).toBe(true);
    expect(patents[1].coversValuedIndication).toBe(false);
    expect(patents[2].coversValuedIndication).toBeUndefined();
    expect(flags.join(" ")).toMatch(/US-unk: no explicit indication scope/);
  });

  it("SECOND-INDICATION SCOPE: an MOU patent for another indication cannot protect this one", () => {
    // The lead's IPF method-of-use patent must not extend the solid-tumour indication's window.
    const { patents } = patentsFromKeyPatents([
      { number: "US-ipf-mou", type: "method-of-use", baseExpiry: 2045, coversValuedIndication: false },
    ]);
    const r = resolveLoe({ approvalYear: 2028, exclusivity: { isNCE: true }, patents });
    expect(r.patentCeilingYear).toBeNull();
    expect(r.expectedLoeYear).toBe(2033); // NCE 5yr only — NOT 2045
    expect(r.flags.join(" ")).toMatch(/does not cover the valued indication/);
  });

  it("a REASONED pProtective is used inside its type band, and clamped outside it", () => {
    // In band: an MOU patent with no other indication to skinny-label into is genuinely stronger.
    const inBand = patentsFromKeyPatents([
      { number: "US-mou", type: "method-of-use", baseExpiry: 2042, coversValuedIndication: true,
        pProtective: 0.55, pProtectiveRationale: "sole approved indication — no use left to carve out" },
    ]).patents;
    const rIn = resolveLoe({ approvalYear: 2030, exclusivity: { isNCE: true }, patents: inBand });
    expect(rIn.cases[0].weight).toBeCloseTo(0.55, 6);
    // Out of band (0.95 for a method-of-use) → clamped to the band max 0.60 + flagged.
    const outBand = patentsFromKeyPatents([
      { number: "US-mou", type: "method-of-use", baseExpiry: 2042, coversValuedIndication: true,
        pProtective: 0.95, pProtectiveRationale: "asserts it is bulletproof" },
    ]).patents;
    const rOut = resolveLoe({ approvalYear: 2030, exclusivity: { isNCE: true }, patents: outBand });
    expect(rOut.cases[0].weight).toBeCloseTo(P_PROTECTIVE_BAND["method-of-use"].max, 6);
    expect(rOut.flags.join(" ")).toMatch(/OUTSIDE the method-of-use band/);
  });

  it("tolerates a non-array (no patents retrieved) without throwing", () => {
    expect(patentsFromKeyPatents(undefined).patents).toEqual([]);
    expect(patentsFromKeyPatents(null).patents).toEqual([]);
  });
});

describe("publicStatementsFromMarketIntel adapter", () => {
  it("keeps only entries that BOTH name a source and mention a year", () => {
    const out = publicStatementsFromMarketIntel([
      { source: "EvaluatePharma", loeYearMentioned: 2038, snippet: "LOE 2038" },
      { source: "no year given", loeYearMentioned: null },
      { source: "  ", loeYearMentioned: 2040 },
      { loeYearMentioned: 2041 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ statedYear: 2038, source: "EvaluatePharma" });
  });

  it("tolerates a missing/non-array marketIntelligence", () => {
    expect(publicStatementsFromMarketIntel(undefined)).toEqual([]);
    expect(publicStatementsFromMarketIntel({})).toEqual([]);
  });

  it("an impossible sourced statement is floored at statute end-to-end (the live 'LOE ~2026')", () => {
    const statements = publicStatementsFromMarketIntel([{ source: "HCPLive", loeYearMentioned: 2026, snippet: "LOE ~2026" }]);
    const r = resolveLoe({ approvalYear: 2031, exclusivity: { orphanConfirmedForIndication: true }, publicStatements: statements });
    expect(r.expectedLoeYear).toBe(2038);
    expect(r.flags.join(" ")).toMatch(/BELOW the statutory exclusivity floor/);
  });
});

describe("computeLoeYear capability gate (harness/product parity)", () => {
  // THE TALADEGIB REGRESSION, both sides. Identical inputs; the ONLY difference is whether structured
  // observables are supplied. Absent → the legacy path must be bit-for-bit unchanged (this is what keeps the
  // FROZEN fixtures byte-identical). Present → orphan ODE is driven by the CONFIRMED designation rather than
  // by the LLM-emitted regulatoryContext, which is the actual bug.
  const common = {
    launchYear: 2031,
    modality: "small_molecule" as const,
    regulatoryContext: "standard" as any, // the LLM emitted "Standard" despite a confirmed FDA/EC orphan
    orphanConfirmed: true,
  };

  it("WITHOUT structured inputs: legacy behaviour preserved (regulatoryContext gates orphan → launch+5)", () => {
    const legacy = computeLoeYear(common);
    expect(legacy.loeYear).toBe(2036);          // NCE 5y only — the orphan term is lost
    expect(legacy.basis).toBe("exclusivity");
    expect(legacy.cases).toBeUndefined();        // structured-only field stays absent
    expect(legacy.provenance).toMatch(/^(pinned|estimate):/);
  });

  it("WITH structured inputs: the CONFIRMED orphan designation drives ODE → approval+7", () => {
    const resolved = computeLoeYear({ ...common, structured: {} });
    expect(resolved.loeYear).toBe(2038);         // 2031 + 7, the correct window
    expect(resolved.exclusivityYears).toBe(7);
    expect(resolved.cases).toHaveLength(1);
    expect(resolved.provenance).toMatch(/^(pinned|estimate):/); // the prefix contract the harness asserts
  });

  it("WITH structured inputs: a pre-approval compound patent is moot; ODE still governs", () => {
    // US9000023 expires ~2029 but approval is 2031 → cannot protect, PTE-ineligible (§156 in-force rule).
    const r = computeLoeYear({
      ...common,
      structured: { patents: patentsFromKeyPatents([{ number: "US9000023", type: "compound", baseExpiry: 2029 }]).patents },
    });
    expect(r.loeYear).toBe(2038);
    expect(r.loeFlags!.join(" ")).toMatch(/BEFORE approval/);
  });

  it("WITH structured inputs: a live method-of-use patent yields a WEIGHTED distribution", () => {
    const r = computeLoeYear({
      ...common,
      structured: { patents: patentsFromKeyPatents([{ number: "AU2021360767A1", type: "method-of-use", baseExpiry: 2041 }]).patents },
    });
    expect(r.cases).toHaveLength(2);
    expect(r.cases!.map((c) => c.basis).sort()).toEqual(["exclusivity", "patent"]);
    expect(r.loeYear).toBeGreaterThan(2038); // weight-average sits above the pure ODE floor
    expect(r.loeYear).toBeLessThan(2041);    // …but well below asserting the MOU patent holds
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
