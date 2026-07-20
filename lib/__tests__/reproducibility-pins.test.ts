import { describe, it, expect } from "vitest";
import {
  resolveRegulatoryContext, designationsToContext, parseDesignations,
} from "../regulatory-pins";
import { classGraveyardProbability, graveyardHaircut } from "../class-risk";
import { pinComparator, isEarlyAlzheimers, isColorectalMRD } from "../indication-benchmarks";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import type { TrialDesignInputs, RegulatoryContext } from "../ptrs-trial";

// ─── Reproducibility pins (tau: pin the qualitative classifications) ────────────
// These lock the DETERMINISM of the classifications that were flipping run-to-run
// (regContext btd↔standard, classStatus graveyard↔mixed, AD comparator nullRR).
// The probability MATH is unchanged — only its INPUTS are pinned; the FROZEN_PAPPROVAL
// tripwire in the harness proves the engine itself did not move.

const design = (o: Partial<TrialDesignInputs> = {}): TrialDesignInputs => ({
  n: 300, endpointType: "surrogate", designType: "rct",
  populationType: "broad", placeboResponse: "low", regulatoryContext: "standard", ...o,
});
const stage = (o: Partial<DevStageInput> = {}): DevStageInput => ({
  id: "s", name: "st", phase: "Phase 2", n: 300, cpp: 200000,
  trialDesign: design({ regulatoryContext: (o.trialDesign?.regulatoryContext) ?? "standard" }),
  isCurrentTrial: true, enrollmentRatePerMonth: 15, treatmentObsMonths: 12,
  startupCushionMonths: 6, isTimeToEvent: false, nullResponseRate: 0.2, ...o,
});
const plan = (opts: { reg?: RegulatoryContext; classStatus?: any; pG?: number }) =>
  computeDevPlan(
    mixtureFromMssVariance(0.5, 0.15), 0.1,
    {
      stages: [stage({ trialDesign: design({ regulatoryContext: opts.reg ?? "standard" }) })],
      regulatoryContext: opts.reg ?? "standard",
      modalityClassStatus: opts.classStatus,
      classGraveyardProbability: opts.pG,
    },
    1000,
  );

// ── PART 1: regContext is a deterministic FACTUAL lookup ────────────────────────
describe("Part 1 — regulatory designation pin", () => {
  it("resolves tau (BMS-986446) to fast_track from the registry, every time", () => {
    const a = resolveRegulatoryContext({ asset: "BMS-986446" });
    const b = resolveRegulatoryContext({ asset: "bms 986446" }); // normalization
    expect(a.context).toBe("fast_track");
    expect(a.confirmed).toBe(true);
    expect(a.designations).toEqual(["fast_track"]);
    expect(b.context).toBe("fast_track"); // deterministic + normalized
  });

  it("defaults an unregistered asset (e.g. TTX-MC138) to standard — no unearned benefit", () => {
    const r = resolveRegulatoryContext({ asset: "TTX-MC138" });
    expect(r.context).toBe("standard");
    expect(r.confirmed).toBe(false);
  });

  it("maps each designation to its correct context (Fast Track is NOT Breakthrough)", () => {
    expect(designationsToContext(["fast_track"])).toBe("fast_track");
    expect(designationsToContext(["breakthrough"])).toBe("btd");
    expect(designationsToContext(["accelerated"])).toBe("accelerated");
    expect(designationsToContext(["orphan"])).toBe("orphan");
    expect(designationsToContext(["breakthrough", "orphan"])).toBe("btd_orphan");
    expect(designationsToContext([])).toBe("standard");
    expect(parseDesignations("Granted Fast Track designation")).toEqual(["fast_track"]);
    expect(parseDesignations("Breakthrough Therapy")).toEqual(["breakthrough"]);
  });

  it("Fast Track confers NO bar-ease and NO approval bump (== standard for P), only faster review", () => {
    const std = plan({ reg: "standard" });
    const ft = plan({ reg: "fast_track" });
    const btd = plan({ reg: "btd" });
    // Probability is IDENTICAL to standard — Fast Track must not be over-credited.
    expect(ft.pApproval).toBeCloseTo(std.pApproval, 10);
    expect(ft.pAllTrialsSuccess).toBeCloseTo(std.pAllTrialsSuccess, 10);
    expect(ft.regStage.pApproval).toBeCloseTo(std.regStage.pApproval, 10);
    // BTD genuinely eases the bar + bumps approval → strictly higher P (proves FT ≠ BTD).
    expect(btd.pApproval).toBeGreaterThan(ft.pApproval + 1e-6);
    // The ONLY engine effect vs standard: a modestly faster review timeline.
    expect(ft.regStage.reviewMonths).toBe(10);
    expect(std.regStage.reviewMonths).toBe(12);
    expect(ft.totalDurationMonths).toBeLessThan(std.totalDurationMonths);
  });
});

// ── PART 2: classStatus is a deterministic FUNCTION → probability, not a flip ────
describe("Part 2 — class-graveyard probability + haircut blend", () => {
  const tauLike = { sameTargetFailures: 6, approvedInClass: 0, differentiatedSubMechanismWithPOC: true };
  const pureGraveyard = { sameTargetFailures: 6, approvedInClass: 0, differentiatedSubMechanismWithPOC: false };

  it("same evidence → same p_graveyard every call (kills the graveyard↔mixed flip)", () => {
    const a = classGraveyardProbability(tauLike);
    const b = classGraveyardProbability({ ...tauLike });
    expect(a).toEqual(b);
    expect(a.pGraveyard).toBeGreaterThan(0);
    expect(a.pGraveyard).toBeLessThan(1);
  });

  it("differentiation discounts a heavily-failed class (mixed) vs a bare graveyard", () => {
    const tau = classGraveyardProbability(tauLike);
    const grave = classGraveyardProbability(pureGraveyard);
    expect(tau.pGraveyard).toBeLessThan(grave.pGraveyard); // POC de-risks
    expect(tau.classStatus).toBe("mixed");
    expect(grave.classStatus).toBe("graveyard");
  });

  it("approvals → precedent (low residual); no data → none (zero)", () => {
    expect(classGraveyardProbability({ sameTargetFailures: 2, approvedInClass: 1, differentiatedSubMechanismWithPOC: false }).classStatus).toBe("precedent");
    const none = classGraveyardProbability({ sameTargetFailures: 0, approvedInClass: 0, differentiatedSubMechanismWithPOC: false });
    expect(none.classStatus).toBe("none");
    expect(none.pGraveyard).toBe(0);
  });

  it("haircut is the exact blend 1 − 0.20·p_graveyard", () => {
    expect(graveyardHaircut(1, 0.8)).toBeCloseTo(0.80, 10);
    expect(graveyardHaircut(0, 0.8)).toBeCloseTo(1.00, 10);
    expect(graveyardHaircut(0.5, 0.8)).toBeCloseTo(0.90, 10);
    expect(graveyardHaircut(0.65, 0.8)).toBeCloseTo(0.87, 10);
  });

  it("dev plan: p=1 reproduces the old binary graveyard haircut EXACTLY (byte-identical)", () => {
    const viaProb = plan({ pG: 1 });
    const viaLabel = plan({ classStatus: "graveyard" });
    expect(viaProb.pApproval).toBeCloseTo(viaLabel.pApproval, 12);
    for (const st of viaProb.stages) expect(st.modalityHaircut).toBeCloseTo(0.80, 10);
  });

  it("dev plan: p=0 == no haircut; intermediate p sits strictly between", () => {
    const none = plan({ pG: 0 });
    const noClass = plan({}); // no class input at all
    const mid = plan({ pG: 0.5 });
    const full = plan({ pG: 1 });
    expect(none.pApproval).toBeCloseTo(noClass.pApproval, 12);
    for (const st of none.stages) expect(st.modalityHaircut).toBeCloseTo(1.0, 10);
    for (const st of mid.stages) expect(st.modalityHaircut).toBeCloseTo(0.90, 10);
    expect(mid.pApproval).toBeLessThan(none.pApproval);
    expect(mid.pApproval).toBeGreaterThan(full.pApproval);
  });
});

// ── PART 4: the AD comparator is pinned (extends the per-indication mechanism) ───
describe("Part 4 — Alzheimer's comparator pin", () => {
  it("pins early-AD CDR-SB rate stages to a cited value with honest σ²", () => {
    const pin = pinComparator("Early Alzheimer's Disease (MCI due to AD; CDR-SB 0.5–1.0; amyloid-confirmed)", true);
    expect(pin).not.toBeNull();
    expect(pin!.nullResponseRate).toBe(0.10);
    expect(pin!.comparatorSigma2).toBe(0.010);
    expect(pin!.source).toMatch(/CLARITY-AD|TRAILBLAZER/);
    expect(isEarlyAlzheimers("early Alzheimer's, MCI, amyloid-confirmed")).toBe(true);
  });

  it("does not fire for a time-to-event AD stage, nor for unrelated indications", () => {
    expect(pinComparator("Early Alzheimer's Disease", false)).toBeNull();
    expect(pinComparator("metastatic breast cancer", true)).toBeNull();
  });

  it("TTX's CRC comparator is UNCHANGED (0.05) and TTX resolves to standard reg", () => {
    const crc = pinComparator("ctDNA+ MRD colorectal cancer adjuvant", true);
    expect(crc!.nullResponseRate).toBe(0.05);
    expect(isColorectalMRD("ctDNA+ MRD colorectal cancer adjuvant")).toBe(true);
    expect(resolveRegulatoryContext({ asset: "TTX-MC138" }).context).toBe("standard");
  });
});
