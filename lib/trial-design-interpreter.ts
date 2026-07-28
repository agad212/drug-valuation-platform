// lib/trial-design-interpreter.ts
//
// LAYER 2 — the design interpreter's DETERMINISTIC core. A free-form trial-design request is mapped
// by an LLM (in pages/api/design-interpreter.ts) to a raw JSON object; THIS module validates that
// object into a TrialDesignSpec that Layer 1 can compute from.
//
// THE NO-LEAK GUARANTEE (structural, provable — the whole point of building Layer 1 first):
//   • The LLM SPECIFIES the design; deterministic Layer-1 code COMPUTES the number. The LLM NEVER
//     emits power / P(approval) / eNPV — those are Layer-1's output, produced downstream from this spec.
//   • This module imports NOTHING from Layer 1 (no computeStageRR / computeDevPlan / rrTrialPower /
//     computeOption). Grep-provable: the interpreter emits specs, never numbers.
//   • validateDesignSpec returns ONLY { spec, flags, assumptions } — there is NO numeric-result field
//     on the return type or on TrialDesignSpec (tsc-enforced). A number cannot leave here.
//   • The parse is a WHITELIST: only known design-parameter keys are copied onto the spec. If the LLM
//     hallucinates "power": 0.8 / "pApproval": 0.6 / "eNPV": …, those keys are simply never read.
//
// Two-stage validation (Zod was not a project dependency, so a hand-rolled deterministic validator is
// used — same discipline: a shape/type stage, then a semantic/range/support stage):
//   STAGE 1 (shape): types + required-per-family. Malformed → the offending family is dropped + flag.
//   STAGE 2 (semantic): ranges, cross-family consistency, supported-vs-flagged. Invalid → dropped/
//     rejected + flag; UNSUPPORTED → flag + fallback to the nearest supported (BOTH flags surfaced).
// Under-specified structural knobs → labeled DEFAULTS recorded as Assumptions. Effect-anchoring knobs
// (HR, SD/Δ, θ₀) are NEVER defaulted — missing → the family is rejected + flag.

// ── enums kept LOCAL so the module imports nothing (cleanest no-leak import graph) ──
export type DesignType = "rct" | "single_arm" | "basket";
export type SpendingShape = "OBF" | "POCOCK";
export type FutilityType = "beta-spending" | "conditional-power" | "none";

const DESIGN_TYPES: DesignType[] = ["rct", "single_arm", "basket"];
const SPENDING_SHAPES: SpendingShape[] = ["OBF", "POCOCK"];

// ⚠ DESIGN PARAMETERS ONLY. NEVER add a result/power/probability/eNPV field here — the LLM must not
// emit computed numbers; Layer 1 (computeStageRR / computeDevPlan) computes them from this spec.
export type TrialDesignSpec = {
  n?: number;
  designType?: DesignType;
  endpointType?: string; // pass-through (Layer-1 maps); non-critical to the power math's correctness
  populationType?: string;
  regulatoryContext?: string;
  nullResponseRate?: number;
  isTimeToEvent?: boolean;
  alpha?: { value: number; sided?: 1 | 2; multiplicity?: number };
  continuous?: { outcomeSd: number; expectedDelta: number };
  tte?: { expectedHR: number; events?: number; accrual?: TteAccrualSpec };
  sequential?: {
    lookFractions: number[];
    spending?: SpendingShape;
    futility?: { futilityType: "beta-spending" | "none"; binding?: boolean; beta?: number; spending?: SpendingShape };
  };
  bayesian?: { refTheta: number; postThreshold: number; analysisPrior?: { a: number; b: number } };
  // Which STAGE the described design addresses (a design param — WHICH trial, not a computed number).
  // A phase label ("Phase 3"), "pivotal"/"registration"/"last", or a 0-based stage index. Resolved to
  // a concrete stage against the actual plan by resolveStageTarget (at the bridge). Unstated → pivotal,
  // as a SURFACED assumption — never a silent whole-plan application.
  stageTarget?: number | string;
};

export type TteAccrualSpec = {
  controlMedianMonths: number;
  accrualMonths: number;
  followupMonths: number;
  dropoutHazardPerMonth?: number;
  nTotal: number;
};

export type FamilyFlag = {
  code: string;
  severity: "reject" | "fallback" | "info";
  message: string;
};

// Structured (never prose) — the seam the user, the self-check layer, and calibration all read to see
// EXACTLY what was assumed. Every filled default / override lands here.
export type Assumption = { field: string; value: string | number | boolean; source: "user" | "default" | "inferred" };

export type InterpretResult = {
  spec: TrialDesignSpec;
  flags: FamilyFlag[];
  assumptions: Assumption[];
  rejected: boolean; // true only when the raw input was unusable as a whole (→ empty spec → base path)
};

// ── helpers ──
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const inOpen = (x: unknown, lo: number, hi: number): x is number => isNum(x) && x > lo && x < hi;
const inHalfOpen = (x: unknown, lo: number, hi: number): x is number => isNum(x) && x > lo && x <= hi;

/**
 * Validate a raw (LLM-emitted) object into a computable TrialDesignSpec. Pure + deterministic.
 * Returns a spec that is ALWAYS safe to feed to Layer 1 (invalid/unsupported families are dropped),
 * plus the flags and structured assumptions explaining every deviation.
 */
export function validateDesignSpec(raw: unknown): InterpretResult {
  const flags: FamilyFlag[] = [];
  const assumptions: Assumption[] = [];
  const spec: TrialDesignSpec = {};

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      spec,
      flags: [{ code: "malformed-spec", severity: "reject", message: "design spec is not an object — no design applied (base path)" }],
      assumptions,
      rejected: true,
    };
  }
  const r = raw as Record<string, unknown>;

  // ── top-level scalars (whitelist: only these keys are ever read) ──
  if (r.designType !== undefined) {
    if (DESIGN_TYPES.includes(r.designType as DesignType)) spec.designType = r.designType as DesignType;
    else flags.push({ code: "bad-designType", severity: "reject", message: `designType "${String(r.designType)}" not recognized — ignored` });
  }
  if (typeof r.endpointType === "string") spec.endpointType = r.endpointType;
  if (typeof r.populationType === "string") spec.populationType = r.populationType;
  if (typeof r.regulatoryContext === "string") spec.regulatoryContext = r.regulatoryContext;
  if (r.n !== undefined) {
    if (isNum(r.n) && r.n > 0) spec.n = r.n;
    else flags.push({ code: "bad-n", severity: "reject", message: `n must be > 0 — ignored` });
  }
  if (r.nullResponseRate !== undefined) {
    if (inOpen(r.nullResponseRate, 0, 1)) spec.nullResponseRate = r.nullResponseRate;
    else flags.push({ code: "bad-nullResponseRate", severity: "reject", message: `nullResponseRate must be in (0,1) — ignored` });
  }
  if (typeof r.isTimeToEvent === "boolean") spec.isTimeToEvent = r.isTimeToEvent;

  // ── ALPHA (free significance level). USER alpha wins; if regulatoryContext also present, record the override. ──
  if (r.alpha !== undefined) {
    const a = r.alpha as Record<string, unknown>;
    if (a && typeof a === "object" && inOpen(a.value, 0, 0.5)) {
      const sided = a.sided === 2 ? 2 : 1;
      const mult = isNum(a.multiplicity) && a.multiplicity >= 1 ? a.multiplicity : undefined;
      spec.alpha = { value: a.value, sided, ...(mult ? { multiplicity: mult } : {}) };
      assumptions.push({
        field: "alpha.value",
        value: spec.regulatoryContext ? `${a.value} (${sided}-sided; overrides ${spec.regulatoryContext} category)` : `${a.value} (${sided}-sided)`,
        source: "user",
      });
      if (a.sided === undefined) assumptions.push({ field: "alpha.sided", value: 1, source: "default" });
    } else {
      flags.push({ code: "bad-alpha", severity: "reject", message: `alpha.value must be in (0,0.5) — alpha ignored (regulatory-context default used)` });
    }
  }

  // ── CONTINUOUS (SD + Δ). Both REQUIRED; missing → reject family → Layer-1 proportion fallback. ──
  if (r.continuous !== undefined) {
    const c = r.continuous as Record<string, unknown>;
    if (c && typeof c === "object" && isNum(c.outcomeSd) && c.outcomeSd > 0 && isNum(c.expectedDelta) && c.expectedDelta > 0) {
      spec.continuous = { outcomeSd: c.outcomeSd, expectedDelta: c.expectedDelta };
    } else {
      flags.push({ code: "continuous-incomplete", severity: "fallback", message: `continuous endpoint needs a positive outcomeSd AND expectedDelta (never defaulted — they anchor the effect)` });
      flags.push({ code: "continuous-fallback", severity: "info", message: `computed with the proportion/response-rate path instead` });
    }
  }

  // ── TTE (Schoenfeld, RCT only in Layer 1). expectedHR REQUIRED (the effect anchor; never defaulted). ──
  if (r.tte !== undefined) {
    const tt = r.tte as Record<string, unknown>;
    const hrOk = tt && typeof tt === "object" && isNum(tt.expectedHR) && tt.expectedHR > 0 && tt.expectedHR !== 1;
    if (!hrOk) {
      flags.push({ code: "tte-incomplete", severity: "reject", message: `native TTE needs expectedHR > 0 (≠ 1) — the effect anchor, never defaulted — TTE ignored` });
    } else if (spec.designType && spec.designType !== "rct") {
      // single-arm / basket native TTE is NOT supported → flag + fallback to the RR-proxy
      flags.push({ code: "tte-single-arm-unsupported", severity: "fallback", message: `native TTE is RCT-only; single-arm/basket TTE is not computable yet` });
      flags.push({ code: "tte-single-arm-fallback", severity: "info", message: `computed with the time-to-event RR-proxy instead` });
    } else {
      const accrual = validateAccrual(tt.accrual, flags);
      const events = isNum(tt.events) && tt.events > 0 ? tt.events : undefined;
      if (events == null && accrual == null) {
        flags.push({ code: "tte-no-information", severity: "reject", message: `native TTE needs events OR an accrual sub-model — TTE ignored` });
      } else {
        spec.tte = { expectedHR: tt.expectedHR as number, ...(events != null ? { events } : {}), ...(accrual ? { accrual } : {}) }; // hrOk validated expectedHR above
      }
    }
  }

  // ── SEQUENTIAL (group-sequential efficacy + optional β-spending futility). ──
  if (r.sequential !== undefined) {
    const s = r.sequential as Record<string, unknown>;
    const looks = Array.isArray(s?.lookFractions) ? (s.lookFractions as unknown[]) : null;
    if (!looks || looks.length < 1) {
      // under-specified schedule → labeled default (a VISIBLE assumption, not a silent choice)
      spec.sequential = { lookFractions: [0.5, 1] };
      assumptions.push({ field: "sequential.lookFractions", value: "[0.5, 1] (K=2, equally spaced)", source: "default" });
    } else if (validLookFractions(looks)) {
      spec.sequential = { lookFractions: looks as number[] };
    } else {
      flags.push({ code: "bad-look-fractions", severity: "reject", message: `look fractions must be in (0,1] and strictly increasing — sequential ignored` });
    }
    if (spec.sequential) {
      // spending shape (default OBF, surfaced)
      if (SPENDING_SHAPES.includes(s.spending as SpendingShape)) spec.sequential.spending = s.spending as SpendingShape;
      else {
        spec.sequential.spending = "OBF";
        assumptions.push({ field: "sequential.spending", value: "OBF (O'Brien-Fleming)", source: "default" });
      }
      // futility
      if (s.futility !== undefined) {
        const f = s.futility as Record<string, unknown>;
        const ft = f?.futilityType;
        if (ft === "conditional-power") {
          flags.push({ code: "cp-futility-unsupported", severity: "fallback", message: `conditional-power futility is not computable yet` });
          flags.push({ code: "cp-futility-fallback", severity: "info", message: `computed with efficacy-only group-sequential (no futility) instead` });
        } else if (ft === "beta-spending") {
          const binding = typeof f.binding === "boolean" ? f.binding : false;
          if (typeof f.binding !== "boolean") assumptions.push({ field: "sequential.futility.binding", value: "false (non-binding, advisory)", source: "default" });
          const beta = inOpen(f.beta, 0, 0.5) ? (f.beta as number) : 0.1;
          if (!inOpen(f.beta, 0, 0.5)) assumptions.push({ field: "sequential.futility.beta", value: 0.1, source: "default" });
          const fSpend = SPENDING_SHAPES.includes(f.spending as SpendingShape) ? (f.spending as SpendingShape) : "OBF";
          if (!SPENDING_SHAPES.includes(f.spending as SpendingShape)) assumptions.push({ field: "sequential.futility.spending", value: "OBF", source: "default" });
          spec.sequential.futility = { futilityType: "beta-spending", binding, beta, spending: fSpend };
        }
        // futilityType "none" or absent → no futility (nothing to do)
      }
    }
  }

  // ── BAYESIAN (single-look posterior-threshold). refTheta + postThreshold REQUIRED. ──
  if (r.bayesian !== undefined) {
    const b = r.bayesian as Record<string, unknown>;
    if (b?.predictive !== undefined) {
      flags.push({ code: "bayesian-pp-unsupported", severity: "fallback", message: `Bayesian predictive-probability (sequential) is not computable yet` });
      flags.push({ code: "bayesian-pp-fallback", severity: "info", message: `computed with the single-look posterior-threshold rule instead` });
    }
    if (inOpen(b?.refTheta, 0, 1) && inOpen(b?.postThreshold, 0, 1)) {
      const ap = b.analysisPrior as Record<string, unknown> | undefined;
      let analysisPrior: { a: number; b: number } | undefined;
      if (ap && isNum(ap.a) && ap.a > 0 && isNum(ap.b) && ap.b > 0) analysisPrior = { a: ap.a, b: ap.b };
      else {
        analysisPrior = { a: 1, b: 1 };
        assumptions.push({ field: "bayesian.analysisPrior", value: "reference Beta(1,1), not sourced", source: "default" });
      }
      spec.bayesian = { refTheta: b.refTheta as number, postThreshold: b.postThreshold as number, analysisPrior };
    } else {
      flags.push({ code: "bayesian-incomplete", severity: "reject", message: `Bayesian rule needs refTheta ∈ (0,1) AND postThreshold ∈ (0,1) — Bayesian ignored (frequentist rule used)` });
    }
  }

  // ── CROSS-FAMILY consistency (deterministic, before any math) ──
  if (spec.continuous && spec.tte) {
    delete spec.tte;
    flags.push({ code: "endpoint-family-conflict", severity: "reject", message: `continuous and TTE are mutually exclusive endpoint families — TTE dropped, continuous kept` });
  }
  if (spec.sequential && spec.bayesian) {
    // sequential + Bayesian = predictive-probability (deferred) → keep the frequentist group-sequential
    delete spec.bayesian;
    flags.push({ code: "predictive-probability-unsupported", severity: "fallback", message: `sequential + Bayesian = predictive-probability, not computable yet` });
    flags.push({ code: "predictive-probability-fallback", severity: "info", message: `computed with the frequentist group-sequential design (Bayesian rule dropped)` });
  }

  // ── STAGE-ADDRESSABLE: which stage does this design target? A design param (WHICH trial), not a
  //    computed number. Unstated → pivotal (registration), emitted as a SURFACED assumption — never a
  //    silent whole-plan application. The concrete index is resolved against the real plan by
  //    resolveStageTarget at the bridge (out-of-range/unresolvable → flag + fallback to pivotal).
  const hasContent = Object.keys(spec).length > 0;
  if (typeof r.stageTarget === "number" && Number.isInteger(r.stageTarget) && r.stageTarget >= 0) {
    spec.stageTarget = r.stageTarget;
    assumptions.push({ field: "stageTarget", value: r.stageTarget, source: "user" });
  } else if (typeof r.stageTarget === "string" && r.stageTarget.trim()) {
    spec.stageTarget = r.stageTarget.trim();
    assumptions.push({ field: "stageTarget", value: r.stageTarget.trim(), source: "user" });
  } else if (hasContent) {
    spec.stageTarget = "pivotal";
    assumptions.push({ field: "stageTarget", value: "pivotal (registration stage) — default; name a stage to change", source: "default" });
  }

  return { spec, flags, assumptions, rejected: false };
}

// Resolve a stageTarget (phase label / "pivotal" / 0-based index) to a concrete stage index against
// the ACTUAL plan. Pure — takes plain stage descriptors (no Layer-1 import). Out-of-range or
// unresolvable → the pivotal (last) stage + a fallback flag (never a silent mis-target).
export function resolveStageTarget(
  stageTarget: number | string | undefined,
  stages: { phase?: string; name?: string }[],
): { index: number; flag?: FamilyFlag } {
  const last = stages.length - 1;
  if (last < 0) return { index: 0 };
  if (stageTarget === undefined) return { index: last };
  if (typeof stageTarget === "number") {
    if (Number.isInteger(stageTarget) && stageTarget >= 0 && stageTarget <= last) return { index: stageTarget };
    return { index: last, flag: { code: "stage-target-out-of-range", severity: "fallback", message: `stageTarget index ${stageTarget} out of range (0..${last}) — applied to the pivotal (registration) stage` } };
  }
  const s = stageTarget.trim().toLowerCase();
  if (s === "pivotal" || s === "registration" || s === "last" || s === "confirmatory") return { index: last };
  const idx = stages.findIndex((st) => (st.phase ?? "").toLowerCase().includes(s) || (st.name ?? "").toLowerCase().includes(s));
  if (idx >= 0) return { index: idx };
  return { index: last, flag: { code: "stage-target-unresolved", severity: "fallback", message: `stageTarget "${stageTarget}" matched no stage — applied to the pivotal (registration) stage` } };
}

function validLookFractions(looks: unknown[]): boolean {
  if (!looks.every((x) => inHalfOpen(x, 0, 1))) return false;
  for (let i = 1; i < looks.length; i++) if ((looks[i] as number) <= (looks[i - 1] as number)) return false; // strictly increasing
  return true;
}

function validateAccrual(raw: unknown, flags: FamilyFlag[]): TteAccrualSpec | undefined {
  if (raw === undefined) return undefined;
  const a = raw as Record<string, unknown>;
  if (
    a && typeof a === "object" &&
    isNum(a.controlMedianMonths) && a.controlMedianMonths > 0 &&
    isNum(a.accrualMonths) && a.accrualMonths > 0 &&
    isNum(a.followupMonths) && a.followupMonths >= 0 &&
    isNum(a.nTotal) && a.nTotal > 0
  ) {
    return {
      controlMedianMonths: a.controlMedianMonths,
      accrualMonths: a.accrualMonths,
      followupMonths: a.followupMonths,
      nTotal: a.nTotal,
      ...(isNum(a.dropoutHazardPerMonth) && a.dropoutHazardPerMonth >= 0 ? { dropoutHazardPerMonth: a.dropoutHazardPerMonth } : {}),
    };
  }
  flags.push({ code: "bad-accrual", severity: "reject", message: `TTE accrual sub-model incomplete/invalid — ignored` });
  return undefined;
}
