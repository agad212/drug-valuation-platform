// lib/self-check.ts
//
// OUTPUT-PLAUSIBILITY SELF-CHECK — a PURE READER over a FINISHED valuation.
//
// THE ONE HARD RULE: this layer OBSERVES and FLAGS ONLY. It NEVER adjusts, clamps, corrects,
// or halts a computed value. A check that mutated a number to make itself pass would be the
// output-adjustment anti-pattern this project spent months deleting, re-introduced at the review
// layer. Output scrutiny, never output adjustment.
//
// STRUCTURAL GUARANTEE (not merely tested): every function here is pure — it reads a flat VIEW
// built from an already-computed result and returns a report. It imports only TYPES from the
// engine (erased at compile; no runtime edge, no possible write-back), and it is imported ONLY by
// display/instrument code, never by any compute module. Because the checker is not in the compute
// path, FROZEN tripwires are byte-identical by construction — wiring it in cannot move a number.
//
// The report is queryable data ({ id, class, severity, pass, read, explain, provisional? }), not
// prose — the seam that the Option B critic and the calibration backtest both consume. Class-B
// thresholds are exactly what calibration will later replace with observed distributions.

import type { DevPlanResult } from "./dev-plan";
import type { OptionResult } from "./decision-analysis";

export type CheckSeverity = "BLOCKER" | "WARN";

export type Check = {
  id: string;
  class: "A" | "B";
  severity: CheckSeverity;
  pass: boolean;
  read: Record<string, number | string | boolean | null>;
  explain: string;
  provisional?: boolean; // true for Class-B hand-set thresholds (pre-calibration)
};

export type Flag = {
  id: string;
  source: string; // where the flag was raised in the engine
  explain: string;
  read?: Record<string, number | string | boolean | null>;
};

export type CheckReport = {
  checks: Check[];
  flags: Flag[];
  blockers: number; // failed Class-A (BLOCKER) count
  warns: number; // failed WARN checks + aggregated flags
  ok: boolean; // blockers === 0 (no impossibility detected)
};

// ── The flat numeric VIEW each check reads. Built by the adapters below from a finished
//    DevPlanResult / OptionResult. A field left undefined means "not available at this surface" →
//    the check that needs it is SKIPPED (returns null), never failed on missing data.
export type ValuationView = {
  label?: string;
  pApproval?: number;
  pAllTrialsSuccess?: number;
  stageProbs?: number[]; // per-stage trialSuccessProb
  stageCumProbs?: number[]; // per-stage cumSuccessProb (cumulative through the stage)
  ptrs?: number;
  ptrsCI?: { lower: number; upper: number };
  eNPVM?: number;
  revenuePVM?: number;
  riskAdjCostM?: number;
  eROI?: number | null;
  launchYear?: number | null;
  loeYear?: number | null;
  impliedLaunchYear?: number | null;
  totalDurationMonths?: number | null;
  asOfYear?: number;
  revenueByYear?: { year: number; revenueM: number }[]; // A5 — only if a ramp schedule is exposed
  // A6: fields the caller asserts MUST be finite / free of placeholders.
  surfacedNumbers?: Record<string, number | null | undefined>;
  surfacedStrings?: Record<string, string | null | undefined>;
  // A8: multi-indication aggregation. `componentRnpvsM` are the per-indication STRUCTURAL
  // contributions ($M) — each already at its own P, own launch, and any conditional P-weight (i.e.
  // the resolved-structure contributions, NOT standalone rNPVs). The headline must equal their sum.
  // Populated only when there is >1 indication; a single-indication surface leaves it undefined.
  multiIndication?: { headlineENPVM: number; componentRnpvsM: number[]; labels?: string[] };
};

// A7 reads the whole option set, comparing each declared-change option's governed tuple to baseline.
export type OptionView = {
  id: string;
  label?: string;
  isBaseline: boolean;
  declaresChange: boolean; // did the option DECLARE an override / parameter change vs baseline?
  tuple: { peakSalesM: number; devCostM: number; ptrs: number; eNPVM: number };
};

export type FlagInput = {
  nicheProvenance?: OptionResult["nicheProvenance"]; // #14 — already structured
  regUnconfirmed?: boolean; // reg-endpoint acceptability held/unconfirmed (lifted boolean)
  enrichmentHeld?: boolean; // biomarker prevalence unsourced → enrichment held at zero
  singleArmFloor?: boolean; // single-arm registration external-control uncertainty floored
};

// ── tolerances ───────────────────────────────────────────────────────────────
const PROB_EPS = 1e-9;
// eNPV is round1 ($0.1M) and eROI round2; a generous absolute+relative band absorbs the rounding
// of the surfaced components while still catching a genuine desync (e.g. +100 vs −50).
const identityTolM = (x: number) => Math.max(0.5, 0.02 * Math.abs(x));
const eroiTol = (x: number) => Math.max(0.05, 0.02 * Math.abs(x));

// ── B1 provisional threshold ───────────────────────────────────────────────────
// HAND-SET (~50×, human-anchored to taladegib's ~65×); PRE-CALIBRATION placeholder — to be
// replaced by an observed eROI distribution once the Tier-2 calibration record exists. WARN only.
export const EROI_CEILING_PROVISIONAL = 50;

function finite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
const PLACEHOLDER_RE = /\b(TODO|TBD|FIXME|PLACEHOLDER|undefined|NaN)\b|^(—|-|\?\?)$/i;

// ══ CLASS A — IMPOSSIBLE (deterministic, no threshold → BLOCKER) ═════════════════

// A1 — every probability in [0,1].
function checkProbRange(v: ValuationView): Check | null {
  const entries: [string, number | undefined][] = [
    ["pApproval", v.pApproval],
    ["pAllTrialsSuccess", v.pAllTrialsSuccess],
    ["ptrs", v.ptrs],
    ["ptrsCI.lower", v.ptrsCI?.lower],
    ["ptrsCI.upper", v.ptrsCI?.upper],
    ...(v.stageProbs ?? []).map((p, i) => [`stageProb[${i}]`, p] as [string, number]),
    ...(v.stageCumProbs ?? []).map((p, i) => [`stageCumProb[${i}]`, p] as [string, number]),
  ];
  const present = entries.filter(([, p]) => p != null);
  if (present.length === 0) return null;
  const bad = present.filter(([, p]) => !finite(p) || (p as number) < -PROB_EPS || (p as number) > 1 + PROB_EPS);
  return {
    id: "A1-prob-range",
    class: "A",
    severity: "BLOCKER",
    pass: bad.length === 0,
    read: Object.fromEntries(present.map(([k, p]) => [k, p as number])),
    explain:
      bad.length === 0
        ? "all probabilities within [0,1]"
        : `probability outside [0,1]: ${bad.map(([k, p]) => `${k}=${p}`).join(", ")} — a probability can never be < 0 or > 1`,
  };
}

// A2 — cumulative probability non-increasing; pApproval ≤ pAllTrials ≤ min(stage prob).
function checkProbMonotonic(v: ValuationView): Check | null {
  const cum = v.stageCumProbs;
  const canStage = !!cum && cum.length >= 2;
  const canSummary = v.pApproval != null && v.pAllTrialsSuccess != null;
  if (!canStage && !canSummary) return null;
  const violations: string[] = [];
  if (canStage) {
    for (let i = 1; i < cum!.length; i++) {
      if (cum![i] > cum![i - 1] + PROB_EPS) violations.push(`cum[${i}]=${cum![i]} > cum[${i - 1}]=${cum![i - 1]}`);
    }
  }
  if (canSummary && v.pApproval! > v.pAllTrialsSuccess! + PROB_EPS) {
    violations.push(`pApproval=${v.pApproval} > pAllTrialsSuccess=${v.pAllTrialsSuccess}`);
  }
  if (v.pAllTrialsSuccess != null && v.stageProbs && v.stageProbs.length) {
    const minStage = Math.min(...v.stageProbs);
    if (v.pAllTrialsSuccess > minStage + PROB_EPS) violations.push(`pAllTrialsSuccess=${v.pAllTrialsSuccess} > min stageProb=${minStage}`);
  }
  return {
    id: "A2-prob-monotonic",
    class: "A",
    severity: "BLOCKER",
    pass: violations.length === 0,
    read: {
      stageCumProbs: (cum ?? []).map((x) => x.toFixed(5)).join(","),
      pApproval: v.pApproval ?? null,
      pAllTrialsSuccess: v.pAllTrialsSuccess ?? null,
    },
    explain:
      violations.length === 0
        ? "cumulative probability non-increasing across stages; pApproval ≤ pAllTrials ≤ min stage"
        : `probability monotonicity violated: ${violations.join("; ")} — cumulative success cannot rise across stages`,
  };
}

// A3 — eNPV / eROI reconcile with their own components (catches a display value desynced from math).
function checkENPVIdentity(v: ValuationView): Check | null {
  const read: Record<string, number | string | null> = {};
  const parts: string[] = [];
  let pass = true;
  // Full eNPV identity — only where pApproval is available (DevPlanResult); definitional there.
  if (finite(v.pApproval) && finite(v.revenuePVM) && finite(v.riskAdjCostM) && finite(v.eNPVM)) {
    const recomputed = v.pApproval * v.revenuePVM - v.riskAdjCostM;
    read.eNPVM = v.eNPVM;
    read.recomputed_eNPVM = Number(recomputed.toFixed(3));
    if (Math.abs(recomputed - v.eNPVM) > identityTolM(v.eNPVM)) {
      pass = false;
      parts.push(`eNPVM=${v.eNPVM} but pApproval·revenuePVM−cost=${recomputed.toFixed(1)}`);
    }
  }
  // eROI identity — uniform (eROI = eNPVM / cost when cost > 0.1). Safe on every surface.
  if (finite(v.eNPVM) && finite(v.riskAdjCostM) && v.riskAdjCostM > 0.1 && v.eROI != null && finite(v.eROI)) {
    const recomputedROI = v.eNPVM / v.riskAdjCostM;
    read.eROI = v.eROI;
    read.recomputed_eROI = Number(recomputedROI.toFixed(3));
    if (Math.abs(recomputedROI - v.eROI) > eroiTol(v.eROI)) {
      pass = false;
      parts.push(`eROI=${v.eROI} but eNPVM/cost=${recomputedROI.toFixed(2)}`);
    }
  }
  if (Object.keys(read).length === 0) return null;
  return {
    id: "A3-enpv-identity",
    class: "A",
    severity: "BLOCKER",
    pass,
    read,
    explain: pass ? "eNPV and eROI reconcile with their components" : `output desynced from its components: ${parts.join("; ")}`,
  };
}

// A4 — timeline ordering (LOE ≥ launch; duration > 0; approval not in the past).
function checkTimeline(v: ValuationView): Check | null {
  const anyField = finite(v.loeYear) || finite(v.launchYear) || finite(v.totalDurationMonths) || finite(v.impliedLaunchYear);
  if (!anyField) return null;
  const violations: string[] = [];
  if (finite(v.loeYear) && finite(v.launchYear) && v.loeYear < v.launchYear) {
    violations.push(`loeYear ${v.loeYear} < launchYear ${v.launchYear} (exclusivity ends before launch)`);
  }
  if (finite(v.totalDurationMonths) && v.totalDurationMonths <= 0) {
    violations.push(`totalDurationMonths ${v.totalDurationMonths} ≤ 0`);
  }
  if (finite(v.impliedLaunchYear) && finite(v.asOfYear) && v.impliedLaunchYear < v.asOfYear) {
    violations.push(`impliedLaunchYear ${v.impliedLaunchYear} < asOfYear ${v.asOfYear} (approval in the past)`);
  }
  return {
    id: "A4-timeline-order",
    class: "A",
    severity: "BLOCKER",
    pass: violations.length === 0,
    read: {
      launchYear: v.launchYear ?? null,
      loeYear: v.loeYear ?? null,
      impliedLaunchYear: v.impliedLaunchYear ?? null,
      totalDurationMonths: v.totalDurationMonths ?? null,
      asOfYear: v.asOfYear ?? null,
    },
    explain:
      violations.length === 0
        ? "timeline ordering consistent (launch ≤ LOE; duration > 0; approval not in the past)"
        : `timeline ordering violated: ${violations.join("; ")}`,
  };
}

// A5 — revenue window. Runs ONLY if a per-year ramp is exposed on the finished object. The engine
// currently surfaces revenuePVM (a scalar PV), not the ramp — so at the live surfaces this returns
// null and the window contradiction (on-market ≤ 0) is caught by A4 instead. Scaffolded here so it
// engages for free once cashflow exposes the schedule; the non-vacuity test drives it directly.
function checkRevenueWindow(v: ValuationView): Check | null {
  if (!v.revenueByYear || v.revenueByYear.length === 0) return null;
  const violations: string[] = [];
  if (finite(v.launchYear)) {
    const pre = v.revenueByYear.filter((r) => r.year < v.launchYear! && r.revenueM > 0);
    if (pre.length) violations.push(`revenue booked before launch: year(s) ${pre.map((r) => r.year).join(",")}`);
  }
  if (finite(v.launchYear) && finite(v.loeYear) && v.loeYear - v.launchYear <= 0) {
    violations.push(`on-market window (loe−launch) = ${v.loeYear - v.launchYear} ≤ 0`);
  }
  return {
    id: "A5-revenue-window",
    class: "A",
    severity: "BLOCKER",
    pass: violations.length === 0,
    read: { launchYear: v.launchYear ?? null, loeYear: v.loeYear ?? null, years: v.revenueByYear.length },
    explain: violations.length === 0 ? "revenue window consistent (none before launch; on-market > 0)" : `revenue window violated: ${violations.join("; ")}`,
  };
}

// A6 — no NaN / null / Infinity in a surfaced numeric field; no placeholder token in a surfaced string.
function checkNoBadValues(v: ValuationView): Check | null {
  const required: Record<string, number | null | undefined> = {
    // core surfaced numbers that must always be finite (eROI excluded — legitimately null at cost≤0.1)
    ...(v.eNPVM !== undefined ? { eNPVM: v.eNPVM } : {}),
    ...(v.revenuePVM !== undefined ? { revenuePVM: v.revenuePVM } : {}),
    ...(v.riskAdjCostM !== undefined ? { riskAdjCostM: v.riskAdjCostM } : {}),
    ...(v.ptrs !== undefined ? { ptrs: v.ptrs } : {}),
    ...(v.pApproval !== undefined ? { pApproval: v.pApproval } : {}),
    ...(v.surfacedNumbers ?? {}),
  };
  const strings = v.surfacedStrings ?? {};
  if (Object.keys(required).length === 0 && Object.keys(strings).length === 0) return null;
  const badNums = Object.entries(required).filter(([, x]) => x === null || x === undefined || !finite(x));
  const badStrs = Object.entries(strings).filter(([, s]) => s == null || PLACEHOLDER_RE.test(String(s).trim()));
  const pass = badNums.length === 0 && badStrs.length === 0;
  return {
    id: "A6-no-bad-values",
    class: "A",
    severity: "BLOCKER",
    pass,
    read: { checkedNumbers: Object.keys(required).length, checkedStrings: Object.keys(strings).length },
    explain: pass
      ? "no NaN / null / placeholder in surfaced fields"
      : `bad surfaced value(s): ${[...badNums.map(([k, x]) => `${k}=${x}`), ...badStrs.map(([k, s]) => `${k}="${s}"`)].join(", ")}`,
  };
}

// A7 — an option that DECLARES a change but whose governed tuple is byte-identical to Option A did
// not re-derive (the change did not take). Two peers with NO declared diff computing identically is
// legitimate ("same in-model") and is NOT a blocker.
function checkOptionsRederived(options: OptionView[]): Check | null {
  const baseline = options.find((o) => o.isBaseline);
  const nonBaseline = options.filter((o) => !o.isBaseline);
  if (!baseline || nonBaseline.length === 0) return null;
  const eq = (a: OptionView["tuple"], b: OptionView["tuple"]) =>
    a.peakSalesM === b.peakSalesM && a.devCostM === b.devCostM && a.ptrs === b.ptrs && a.eNPVM === b.eNPVM;
  const stuck = nonBaseline.filter((o) => o.declaresChange && eq(o.tuple, baseline.tuple));
  return {
    id: "A7-option-rederived",
    class: "A",
    severity: "BLOCKER",
    pass: stuck.length === 0,
    read: { declaredChangeOptions: nonBaseline.filter((o) => o.declaresChange).length, stuck: stuck.map((o) => o.id).join(",") || "none" },
    explain:
      stuck.length === 0
        ? "every declared-change option re-derived to a distinct result"
        : `option(s) ${stuck.map((o) => `"${o.label ?? o.id}"`).join(", ")} declare a change but produced a tuple byte-identical to Option A — the change did not take (didn't re-derive)`,
  };
}

// A8 — multi-indication headline == Σ of per-indication STRUCTURAL contributions. This is the guard
// against the exact bug it was written for: a headline computed as pooled-revenue × a SINGLE P (the
// lead's), which does NOT equal the sum of independently-risked indications. Because the components
// fed here are the resolved-structure contributions (a conditional indication's is already P-weighted;
// a sequential one's launch is already shifted), the target is the CORRECTLY-aggregated Σ — this
// never false-fires on a legitimate conditional/sequential aggregation, only on a flat pooled×one-P.
function checkMultiIndicationAggregation(v: ValuationView): Check | null {
  const mi = v.multiIndication;
  if (!mi || !Array.isArray(mi.componentRnpvsM) || mi.componentRnpvsM.length === 0) return null;
  if (!finite(mi.headlineENPVM) || mi.componentRnpvsM.some((x) => !finite(x))) {
    return {
      id: "A8-multi-indication-aggregation",
      class: "A",
      severity: "BLOCKER",
      pass: false,
      read: { headlineENPVM: mi.headlineENPVM ?? null, components: mi.componentRnpvsM.length },
      explain: "multi-indication headline or a component is non-finite — cannot reconcile the aggregate",
    };
  }
  const structuralSum = mi.componentRnpvsM.reduce((s, x) => s + x, 0);
  const delta = Math.abs(mi.headlineENPVM - structuralSum);
  const pass = delta <= identityTolM(structuralSum);
  return {
    id: "A8-multi-indication-aggregation",
    class: "A",
    severity: "BLOCKER",
    pass,
    read: {
      headlineENPVM: Number(mi.headlineENPVM.toFixed(3)),
      structuralSumM: Number(structuralSum.toFixed(3)),
      components: mi.componentRnpvsM.length,
      deltaM: Number(delta.toFixed(3)),
    },
    explain: pass
      ? `headline eNPV ${mi.headlineENPVM.toFixed(1)}M reconciles with the Σ of ${mi.componentRnpvsM.length} per-indication structural contributions`
      : `headline eNPV ${mi.headlineENPVM.toFixed(1)}M ≠ Σ per-indication structural contributions ${structuralSum.toFixed(1)}M (Δ ${delta.toFixed(1)}M) — the headline is not the sum of independently-risked indications (looks like pooled revenue × a single P)`,
  };
}

// ══ CLASS B — SUSPICIOUS (threshold → WARN-only, provisional pre-calibration) ═════

// B1 — eROI ceiling. WARN only, never blocks, never adjusts eROI. Threshold is a labeled guess.
function checkEROICeiling(v: ValuationView): Check | null {
  if (v.eROI == null || !finite(v.eROI)) return null;
  const over = v.eROI > EROI_CEILING_PROVISIONAL;
  return {
    id: "B1-eroi-ceiling",
    class: "B",
    severity: "WARN",
    provisional: true,
    pass: !over,
    read: { eROI: v.eROI, ceiling: EROI_CEILING_PROVISIONAL },
    explain: over
      ? `eROI ${v.eROI}× exceeds the provisional ceiling ${EROI_CEILING_PROVISIONAL}× — implausibly high, review inputs. Threshold hand-set (~50×, human-anchored to taladegib ~65×); pre-calibration placeholder, to be replaced by an observed distribution.`
      : `eROI ${v.eROI}× within the provisional ceiling ${EROI_CEILING_PROVISIONAL}×`,
  };
}

// ── flag aggregation — collect the engine's existing resolve-or-flag flags into one place.
//    READ-ONLY: every value here is already computed by the engine; nothing is recomputed.
function aggregateFlags(f: FlagInput): Flag[] {
  const flags: Flag[] = [];
  const np = f.nicheProvenance;
  if (np) {
    if (!np.wac.sourced) {
      flags.push({ id: "flag-wac-unsourced", source: "#14 nicheProvenance", explain: "niche WAC unsourced → held at the labeled bounded default", read: { value: np.wac.value, sourced: false } });
    } else if (!np.wac.inBand) {
      flags.push({ id: "flag-wac-out-of-band", source: "#14 nicheProvenance", explain: "niche WAC cited but out-of-band → clamped to the heuristic band", read: { value: np.wac.value, comp: np.wac.comp, inBand: false } });
    }
    if (!np.share.sourced) {
      flags.push({ id: "flag-share-unsourced", source: "#14 nicheProvenance", explain: "niche peak share unsourced → held at the labeled bounded default", read: { value: np.share.value, sourced: false } });
    } else if (!np.share.inBand) {
      flags.push({ id: "flag-share-out-of-band", source: "#14 nicheProvenance", explain: "niche peak share cited but out-of-band → clamped to the heuristic band", read: { value: np.share.value, comp: np.share.comp, inBand: false } });
    }
  }
  if (f.regUnconfirmed) {
    flags.push({ id: "flag-reg-unconfirmed", source: "reg acceptability", explain: "registration-endpoint acceptability UNCONFIRMED — held at base rate, not penalized (absence of evidence is a flag, not a verdict)" });
  }
  if (f.enrichmentHeld) {
    flags.push({ id: "flag-enrichment-held", source: "biomarker prevalence", explain: "biomarker prevalence unsourced — enrichment held at zero (no unearned de-risking)" });
  }
  if (f.singleArmFloor) {
    flags.push({ id: "flag-single-arm-floor", source: "single-arm design", explain: "single-arm registration leans on an external control — historical-benchmark uncertainty floored" });
  }
  return flags;
}

// ── the entry point. Runs every applicable check + aggregates flags into ONE report. ─────────────
export function selfCheck(input: { view?: ValuationView; options?: OptionView[]; flags?: FlagInput }): CheckReport {
  const checks: Check[] = [];
  if (input.view) {
    for (const c of [checkProbRange, checkProbMonotonic, checkENPVIdentity, checkTimeline, checkRevenueWindow, checkNoBadValues, checkMultiIndicationAggregation, checkEROICeiling]) {
      const r = c(input.view);
      if (r) checks.push(r);
    }
  }
  if (input.options && input.options.length) {
    const a7 = checkOptionsRederived(input.options);
    if (a7) checks.push(a7);
  }
  const flags = aggregateFlags(input.flags ?? {});
  const blockers = checks.filter((c) => c.severity === "BLOCKER" && !c.pass).length;
  const warns = checks.filter((c) => c.severity === "WARN" && !c.pass).length + flags.length;
  return { checks, flags, blockers, warns, ok: blockers === 0 };
}

// ══ ADAPTERS — build the flat views from finished engine objects (pure reads, type-only imports) ══

export function viewFromDevPlan(dp: DevPlanResult, opts?: { launchYear?: number | null; loeYear?: number | null; asOfYear?: number }): ValuationView {
  const stages = dp.stages ?? [];
  return {
    label: "base valuation",
    pApproval: dp.pApproval,
    pAllTrialsSuccess: dp.pAllTrialsSuccess,
    stageProbs: stages.map((s) => s.trialSuccessProb),
    stageCumProbs: stages.map((s) => s.cumSuccessProb),
    eNPVM: dp.eNPVM,
    revenuePVM: dp.revenuePVM,
    riskAdjCostM: dp.totalRiskAdjCostM,
    eROI: dp.eROI,
    launchYear: opts?.launchYear ?? null,
    loeYear: opts?.loeYear ?? null,
    impliedLaunchYear: dp.impliedLaunchYear,
    totalDurationMonths: dp.totalDurationMonths,
    asOfYear: opts?.asOfYear,
    surfacedNumbers: { eNPVM: dp.eNPVM, revenuePVM: dp.revenuePVM, riskAdjCostM: dp.totalRiskAdjCostM, pApproval: dp.pApproval, totalDurationMonths: dp.totalDurationMonths, impliedLaunchYear: dp.impliedLaunchYear },
  };
}

// Per-option view. pApproval is deliberately NOT set (the option eNPV identity uses ptrs and is
// validated via the eROI identity), so A3 runs the uniform eROI reconciliation only — no false
// positives on VOI / licensor / added-indication options.
export function viewFromOption(r: OptionResult, opts?: { launchYear?: number | null; loeYear?: number | null; asOfYear?: number }): ValuationView {
  return {
    label: r.option.name ?? r.option.id,
    ptrs: r.ptrs,
    ptrsCI: r.ptrsCI,
    eNPVM: r.eNPVM,
    revenuePVM: r.revenuePVM,
    riskAdjCostM: r.devCostM,
    eROI: r.eROI,
    totalDurationMonths: r.durationMonths ?? null,
    launchYear: opts?.launchYear ?? null,
    loeYear: opts?.loeYear ?? null,
    asOfYear: opts?.asOfYear,
    surfacedNumbers: { eNPVM: r.eNPVM, revenuePVM: r.revenuePVM, devCostM: r.devCostM, ptrs: r.ptrs, peakSalesM: r.peakSalesM },
  };
}

const OPTION_META_KEYS = new Set(["id", "name", "isBaseline", "changesSummary"]);

export function optionViewsFrom(results: OptionResult[]): OptionView[] {
  return results.map((r) => {
    const o = r.option as Record<string, unknown>;
    const declaresChange = !r.option.isBaseline && Object.keys(o).some((k) => !OPTION_META_KEYS.has(k) && o[k] != null);
    return {
      id: r.option.id,
      label: r.option.name,
      isBaseline: !!r.option.isBaseline,
      declaresChange,
      tuple: { peakSalesM: r.peakSalesM, devCostM: r.devCostM, ptrs: r.ptrs, eNPVM: r.eNPVM },
    };
  });
}

export function flagsFromOption(r: OptionResult): FlagInput {
  return {
    nicheProvenance: r.nicheProvenance,
    regUnconfirmed: r.regUnconfirmed,
    enrichmentHeld: r.enrichmentUnsourced,
    // single-arm floor is read from the design type at the surface (no engine change): a single-arm
    // registration design leans on an external control → historical-benchmark uncertainty is floored.
    singleArmFloor: r.option.designType === "single_arm",
  };
}
