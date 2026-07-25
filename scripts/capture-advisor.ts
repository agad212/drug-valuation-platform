/*
 * scripts/capture-advisor.ts — STANDALONE Strategy-Advisor live capture.
 *
 * Never imported by production. Reproduces the EXACT production Strategy Advisor
 * path (components/DecisionAnalysis.tsx): it runs the same live valuation chain
 * capture-fixture.ts uses to build a FAITHFUL base context + devPlan, assembles the
 * same StrategyContext DecisionAnalysis.buildStrategyContext() sends, makes ONE real
 * call to /api/decision-options (live LLM — the generator under test), then runs the
 * emitted options through computeAllOptions — the SAME engine the UI uses.
 *
 * PURPOSE: fixtures can't prove the live generator EMITS the fields Builds 2/3 gate on
 * (biomarker: populationType/biomarkerPrevalence/enrichmentEffectLift; reg: endpointType
 * /endpointEvidenceBasis). This exercises the real generator and prints raw output.
 *
 * This makes REAL LLM/retrieval calls — accepted one-time API cost. Edits ZERO
 * live-path files. One asset, one run.
 *
 * USAGE (server must be running; run from the repo root):
 *   npm run dev                                  # terminal 1
 *   npx tsx scripts/capture-advisor.ts --drug "taladegib" --phase "Phase 2" --q "<strategy question>"
 *
 * Flags: --drug (required) --phase --sponsor --q <question> --base (default http://localhost:3000)
 */

import { runDeterministicChain, type Fixture } from "../tests/harness/fixture-runner";
import { inferTherapeuticArea, inferModality, classifyComps } from "../lib/financial-pins";
import { classGraveyardProbability, graveyardHaircut } from "../lib/class-risk";
import { buildBaseContext, computeAllOptions, type OptionInputs } from "../lib/decision-analysis";
import { resolveRegAcceptanceLevel } from "../lib/dev-plan";
import type { EvidenceStepInput } from "../lib/effect-prior";
import type { DevStageInput } from "../lib/dev-plan";
import type { Valuation } from "../lib/types";

const MODALITY_META_RISK_HAIRCUT = 0.80; // mirrors lib/dev-plan.ts (not exported)

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
const args = parseArgs(process.argv);
const BASE = (args.base as string) || "http://localhost:3000";
const drug = args.drug as string;
const sponsorArg = args.sponsor as string | undefined;
let phase = (args.phase as string) || "Phase 2";
const QUESTION = (args.q as string) ||
  `Compare our strategic development options for ${drug}: (a) stay the current course, ` +
  `(b) enrich to the biomarker-defined responder subpopulation, and (c) run a confirmatory ` +
  `pivotal with a harder clinical endpoint. Which maximizes risk-adjusted value?`;
if (!drug) { console.error("ERROR: --drug is required"); process.exit(1); }

const GATE_CODE = process.env.SITE_ACCESS_CODE || "5252"; // matches lib/gate.gateCode() default
let gateCookie = ""; // set by unlock()

const phaseNum = (p: string) => (p.includes("3") ? 3 : p.includes("2") ? 2 : p.includes("1") ? 1 : 0);
const isEnrollmentComplete = (status?: string) =>
  !!status && /COMPLETED|ACTIVE_NOT_RECRUITING|ENROLLING_BY_INVITATION/i.test(status);

// Unlock the site gate (middleware.ts) so API routes don't 401. Reuses the same
// /api/gate flow the browser uses; the returned cookie is sent on every request.
async function unlock(): Promise<void> {
  const res = await fetch(`${BASE}/api/gate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: GATE_CODE }),
  });
  if (!res.ok) throw new Error(`unlock failed (${res.status}) — check SITE_ACCESS_CODE`);
  const setCookie = res.headers.get("set-cookie") || "";
  gateCookie = setCookie.split(";")[0]; // "dv_gate=<token>"
  if (!gateCookie) throw new Error("unlock returned no cookie");
  console.log("  ✓ site unlocked");
}

async function getJSON(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: gateCookie } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}
async function postJSON(path: string, payload: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: gateCookie }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n?: number | null) => (n != null ? `${(n * 100).toFixed(1)}%` : "—");

async function main() {
  console.log(`\n▶ Strategy-Advisor LIVE capture for "${drug}" via ${BASE} (real LLM calls)\n`);
  await unlock();

  // ── 1-7: live valuation chain (mirrors capture-fixture.ts / index.tsx) ─────────
  const avParams = new URLSearchParams({ drug, phase });
  if (sponsorArg) avParams.set("sponsor", sponsorArg);
  const av = await getJSON(`/api/auto-value?${avParams}`);
  if (!av.indications?.length) throw new Error(`auto-value returned no indications for "${drug}"`);
  const sponsor = av.sponsor || sponsorArg;
  const mechanism = av.mechanism || "";
  phase = av.phase || phase;
  const trials: any[] = av.trials || [];
  const recommendedNctId = av.recommendedNctId || "";
  console.log(`  ✓ auto-value: ${av.indications.length} indication(s), ${trials.length} trials, mechanism="${mechanism}"`);

  const lr = await postJSON(`/api/lead-reasoner`, { drug, sponsor, phase, mechanism, indication: av.indications[0]?.name });
  const brief = lr.brief;
  if (!brief) throw new Error("lead-reasoner returned no brief");
  const briefIndication = brief.base_case_indication?.value || av.indications[0]?.name || "";
  const ptrsPhase = brief.true_stage?.value || phase;
  const briefSocRR = brief.soc_response_rate?.value;
  const efficacyGateNct = brief.efficacy_gate_trial?.trial_id;
  console.log(`  ✓ lead-reasoner: indication="${briefIndication}", stage="${ptrsPhase}", SOC=${briefSocRR ?? "—"}`);

  const l1 = await postJSON(`/api/ptrs-score`, { drug, mechanism, indication: briefIndication, phase: ptrsPhase, sponsor });
  const ciHalfWidth = l1.ptrsCI ? (l1.ptrsCI.upper - l1.ptrsCI.lower) / 2 : 0.10;
  console.log(`  ✓ ptrs-score: mss=${l1.mss}, variance=${l1.variance}`);

  const matchingTrial = trials.find((t) => phaseNum(t.phase || "") >= phaseNum(ptrsPhase));
  const priorNctId = matchingTrial?.nctId;
  const layer2Nct = efficacyGateNct || matchingTrial?.nctId;
  const currentTrial = trials.find((t) => t.nctId === recommendedNctId) || matchingTrial;
  const enrollmentComplete = isEnrollmentComplete(currentTrial?.status);
  const currentTrialCompletionDate = currentTrial?.primaryCompletionDate ?? currentTrial?.completionDate;

  const ep = await postJSON(`/api/effect-prior`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor, nctId: priorNctId,
    mechanism: { mss: l1.mss, variance: l1.variance, summary: l1.summary },
  });
  const chain = ep.effectPrior?.chain;
  if (!chain?.length) throw new Error("effect-prior returned no chain");
  const chainSteps: EvidenceStepInput[] = chain.map((s: any) => ({
    source: s.source, label: s.label, found: s.found,
    ...(s.found && s.signal ? { signal: { mu: s.signal.mu, sigma2: s.signal.sigma2 } } : {}),
    ...(s.classStatus ? { classStatus: s.classStatus } : {}),
    ...(s.classEvidence ? { classEvidence: s.classEvidence } : {}),
    reasoning: s.reasoning ?? "",
  }));
  console.log(`  ✓ effect-prior: ${chainSteps.length} steps, shape="${ep.effectPrior?.shape}"`);

  const l2 = await postJSON(`/api/ptrs-layer2`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor, nctId: layer2Nct,
    layer1: { mss: l1.mss, variance: l1.variance, ptrs: l1.ptrs, ciHalfWidth },
  });
  if (!l2.trialInputs) throw new Error("ptrs-layer2 returned no trialInputs");

  const dp = await postJSON(`/api/dev-plan`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor,
    currentTrialDesign: l2.trialInputs, currentTrialName: drug,
    currentTrialEnrollmentComplete: enrollmentComplete,
    currentTrialCompletionDate,
  });
  if (!dp.stages?.length) throw new Error("dev-plan returned no stages");
  const stages: DevStageInput[] = (dp.stages as DevStageInput[]).map((s) => ({
    ...s, nullResponseRate: s.nullResponseRate ?? briefSocRR,
  }));
  console.log(`  ✓ dev-plan: ${stages.length} stage(s), regContext="${dp.regulatoryContext}"`);

  let peakSales = av.indications[0]?.peakSales || 0;
  let comps: { drug: string; peakSalesM: number }[] = [];
  try {
    const rev = await postJSON(`/api/revenue-assumptions`, { drug, phase: ptrsPhase, indications: [briefIndication], sponsor });
    const ind0 = rev.indications?.[0];
    if (ind0?.peakSalesM > 0) peakSales = Math.round(ind0.peakSalesM * 1e6);
    comps = (ind0?.comps || []).filter((c: any) => c?.peakSalesM > 0).map((c: any) => ({ drug: c.drug, peakSalesM: c.peakSalesM }));
    console.log(`  ✓ revenue-assumptions: peakSales=$${(peakSales / 1e6).toFixed(0)}M, ${comps.length} comps`);
  } catch (e: any) { console.warn(`  ! revenue-assumptions failed (${e.message}); using auto-value peak`); }

  const ind0av = av.indications[0] || {};
  const launchYear = ind0av.launchYear ?? new Date().getFullYear() + 7;
  const loeYear = av.loeYear ?? launchYear + 10;

  // ── Deterministic chain → real effectPrior + devPlan (SAME engine the harness runs) ──
  const analogStep = chainSteps.find((s) => s.source === "analog");
  const analogClass = analogStep?.classStatus ?? null;
  const classRisk = analogStep?.classEvidence ? classGraveyardProbability(analogStep.classEvidence) : null;
  const effectiveClassStatus = classRisk?.classStatus ?? analogClass;
  const effectiveHaircut = classRisk
    ? graveyardHaircut(classRisk.pGraveyard, MODALITY_META_RISK_HAIRCUT)
    : (analogClass === "graveyard" ? MODALITY_META_RISK_HAIRCUT : 1.0);
  const fx: Fixture = {
    meta: { asset: drug, capturedAt: new Date().toISOString().slice(0, 10), note: "advisor-capture",
      expectedHeadline: { pApprovalBand: [0, 1], classStatus: effectiveClassStatus, appliesModalityHaircut: effectiveHaircut < 1 } },
    ciHalfWidth, chainSteps,
    devPlan: { regulatoryContext: dp.regulatoryContext ?? "standard", regCostM: 1.0, stages,
      orphanConfirmedForIndication: l2.orphanConfirmedForIndication === true },
    financial: { therapeuticArea: inferTherapeuticArea(briefIndication), modality: inferModality(mechanism),
      patentLoeYear: av.loeBasis === "patent" ? (av.loeYear ?? null) : null, comps: classifyComps(comps) },
    valuation: { peakSales, launchYear, loeYear, discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21,
      workingCapitalPct: 0.1, avgRoyalty: 0.15, ownerType: "Owner" as const },
  };
  const chainResult = runDeterministicChain(fx);
  const devPlan = chainResult.devPlan;
  const effectPrior = chainResult.effectPrior;
  console.log(`  ✓ deterministic chain: pApproval=${pct(devPlan.pApproval)}, finalMss reproduced, class=${effectiveClassStatus ?? "—"}`);

  // ── Build the SAME base context + StrategyContext the UI builds ────────────────
  const valuation: Valuation = {
    asset: drug, phase: ptrsPhase, mechanism, indication: briefIndication, sponsor,
    discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
    indications: [{
      id: "i1", name: briefIndication, peakSales, launchYear, loeYear,
      devCostPV: Math.round((devPlan.totalRiskAdjCostM ?? 0) * 1e6),
      ...(ind0av.tamM ? { tamM: ind0av.tamM } : {}),
      ...(ind0av.penetrationPct ? { penetrationPct: ind0av.penetrationPct } : {}),
      ...(ind0av.annualPriceUsd ? { annualPriceUsd: ind0av.annualPriceUsd } : {}),
    }] as any,
  };
  const out = {
    ptrs: devPlan.pApproval,
    revenuePV: chainResult.revenuePV,
    devCostPV: Math.round((devPlan.totalRiskAdjCostM ?? 0) * 1e6),
    rnpv: 0,
  };
  const ptrsResult = { mss: l1.mss, variance: l1.variance, ptrs: l1.ptrs, ptrsCI: l1.ptrsCI };
  const base = buildBaseContext(valuation, out, ptrsResult, l2, effectPrior, devPlan);
  if (!base) throw new Error("buildBaseContext returned null");

  const strategyContext = {
    asset: valuation.asset, phase: valuation.phase, mechanism: valuation.mechanism, indication: valuation.indication,
    pApproval: devPlan.pApproval ?? base.ptrs, peakSalesM: base.peakSalesM,
    eNPVM: round1(devPlan.eNPVM), devCostM: base.devCostM, effectShape: effectPrior?.shape,
    currentDesign: {
      n: base.baseTrialDesign.n, endpointType: base.baseTrialDesign.endpointType,
      designType: base.baseTrialDesign.designType, populationType: base.baseTrialDesign.populationType,
      regulatoryContext: base.baseTrialDesign.regulatoryContext, placeboResponse: base.baseTrialDesign.placeboResponse,
    },
    stages: devPlan.stages.map((s: any) => ({
      name: s.name, phase: s.phase, n: s.n, cpp: s.cpp, endpointType: s.trialDesign.endpointType,
      designType: s.trialDesign.designType, populationType: s.trialDesign.populationType,
      trialSuccessProb: s.trialSuccessProb, durationMonths: s.durationMonths,
    })),
  };

  // ── THE GENERATOR CALL (live LLM, the thing under test) ────────────────────────
  console.log(`\n▶ POST /api/decision-options  (live generator)\n  Q: ${QUESTION}\n`);
  const advisor = await postJSON(`/api/decision-options`, { message: QUESTION, context: strategyContext, history: [] });
  const rawOptions: any[] = Array.isArray(advisor.options) ? advisor.options : [];
  if (advisor.parseError) console.log(`  ! parseError: ${advisor.parseError}`);
  if (!rawOptions.length) throw new Error("generator returned zero options");

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("1. RAW EMITTED JSON (verbatim from /api/decision-options):");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(JSON.stringify(rawOptions, null, 2));

  // ── SIGNAL CHECKS (Build 2 + Build 3) ──────────────────────────────────────────
  // Mirror the engine: the reg gate keys on the LAST (registration) plan stage's endpoint,
  // and the graded scale only engages when an option CHANGES it (regEndpointChanged).
  const regPlanStages: any[] = base.devPlanInputs?.stages ?? [];
  const regStageLast = regPlanStages[regPlanStages.length - 1];
  const baseRegEndpointType = regStageLast?.trialDesign?.endpointType ?? base.baseTrialDesign.endpointType;
  const baseRegEndpointBasis = regStageLast?.endpointEvidenceBasis;
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("2 & 3. SIGNAL CHECKS  (base registration endpoint = " + baseRegEndpointType + ")");
  console.log("═══════════════════════════════════════════════════════════════════");
  for (const o of rawOptions) {
    const bioSignal =
      o.populationType === "biomarker_selected" ? `populationType:"biomarker_selected"` :
      o.biomarkerPrevalence != null ? `biomarkerPrevalence:${o.biomarkerPrevalence}` :
      o.enrichmentEffectLift != null ? `enrichmentEffectLift:${o.enrichmentEffectLift}` : null;
    const fires = !!bioSignal;
    const tightOnly = !fires && o.inclusionCriteria === "tight";
    console.log(`\n  [${o.id}] ${o.name}${o.isBaseline ? " (baseline)" : ""}`);
    console.log(`     BUILD-2 biomarker: ${fires ? `FIRES via ${bioSignal}` : (tightOnly ? `NO — only inclusionCriteria:"tight" (OLD-BUG pattern)` : "none (no biomarker signal)")}`);
    console.log(`     BUILD-3 endpoint : endpointType=${o.endpointType ?? "(unset)"}  endpointEvidenceBasis=${o.endpointEvidenceBasis ?? "(unset)"}` +
      `${o.endpointType && o.endpointType !== baseRegEndpointType ? "  → differs from base → reg model engages" : "  → no reg-endpoint change"}`);

    // G1 — REG-ACCEPTANCE axis: gate on the ENGINE's regEndpointChanged. The graded scale is
    // scenario-only — it only applies when the option CHANGES the registration endpoint (type,
    // basis, or any acceptance observable). Otherwise the reg gate uses the FLAT base rate and
    // NO level is resolved — so we must not print a (misleading) resolved level for those.
    const optRegType = o.endpointType ?? baseRegEndpointType;
    const optRegBasis = o.endpointEvidenceBasis ?? baseRegEndpointBasis;
    const optAssertsObs = o.fdaGuidanceForEndpoint != null || o.priorFullApprovalsOnEndpoint != null ||
      o.acceleratedOnlyPrecedent != null || o.approvedInClassOnEndpoint != null;
    const regEndpointChanged = optRegType !== baseRegEndpointType || optRegBasis !== baseRegEndpointBasis || optAssertsObs;
    if (regEndpointChanged) {
      const regObs = {
        endpointType: optRegType,
        ...(o.endpointEvidenceBasis != null ? { endpointEvidenceBasis: o.endpointEvidenceBasis } : {}),
        ...(o.fdaGuidanceForEndpoint != null ? { fdaGuidanceForEndpoint: o.fdaGuidanceForEndpoint } : {}),
        ...(o.priorFullApprovalsOnEndpoint != null ? { priorFullApprovalsOnEndpoint: o.priorFullApprovalsOnEndpoint } : {}),
        ...(o.acceleratedOnlyPrecedent != null ? { acceleratedOnlyPrecedent: o.acceleratedOnlyPrecedent } : {}),
        ...(o.approvedInClassOnEndpoint != null ? { approvedInClassOnEndpoint: o.approvedInClassOnEndpoint } : {}),
      };
      const emittedObs = Object.keys(regObs).filter((k) => k !== "endpointType");
      const { level, flagged } = resolveRegAcceptanceLevel(regObs as any);
      console.log(`     G1 reg-accept   : ENDPOINT CHANGED → graded scale engages; observables=[${emittedObs.length ? emittedObs.join(", ") : "NONE emitted"}] → resolved ${level}${flagged ? " ⚠ FLAGGED" : ""}`);
    } else {
      console.log(`     G1 reg-accept   : base endpoint unchanged → FLAT reg base rate (graded scale NOT applied; no level resolved)`);
    }

    // G2-2a — CONTINUOUS-power axis: both native-scale stats emitted?
    const hasSd = typeof o.outcomeSd === "number" && o.outcomeSd > 0;
    const hasDelta = typeof o.mdeOrExpectedDelta === "number" && o.mdeOrExpectedDelta > 0;
    console.log(`     G2 continuous   : outcomeSd=${o.outcomeSd ?? "(unset)"}  mdeOrExpectedDelta=${o.mdeOrExpectedDelta ?? "(unset)"}` +
      ` → ${hasSd && hasDelta ? "BOTH present → native two-sample z-power" : "incomplete → PROPORTION fallback"}`);
    console.log(`     other: inclusionCriteria=${o.inclusionCriteria ?? "-"} comparatorType=${o.comparatorType ?? "-"} regulatoryContext=${o.regulatoryContext ?? "-"} n=${o.n ?? "-"} designType=${o.designType ?? "-"}`);
  }

  // ── ENGINE RUN (same computeAllOptions the UI uses) → P movement + drivers ──────
  const hasBaseline = rawOptions.some((o) => o.isBaseline);
  const finalOptions: OptionInputs[] = hasBaseline ? rawOptions : [{ id: "opt-a", name: "Current Plan", isBaseline: true }, ...rawOptions];
  const results = computeAllOptions(base, finalOptions);
  const a = results.find((r) => r.option.isBaseline) ?? results[0];
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("4. P MOVEMENT  (computeAllOptions — the real engine; baseline P = " + pct(a.ptrs) + ")");
  console.log("═══════════════════════════════════════════════════════════════════");
  for (const r of results) {
    const delta = r.ptrs - a.ptrs;
    const flag = r.option.isBaseline ? "" : (Math.abs(delta) < 1e-6 ? "  ⟵ FLAT vs baseline" : `  (Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts)`);
    console.log(`\n  [${r.option.id}] ${r.option.name}`);
    console.log(`     P(approval) = ${pct(r.ptrs)}${flag}   eNPV=$${r.eNPVM}M  peak=$${r.peakSalesM}M  devCost=$${r.devCostM}M`);
    if (r.keyDrivers?.length) for (const d of r.keyDrivers) console.log(`       • ${d}`);
  }

  console.log("\n───────────────────────────────────────────────────────────────────");
  console.log(`ADVISOR SUMMARY (sanitized, from generator):\n${advisor.summary || "(none)"}`);
  console.log("───────────────────────────────────────────────────────────────────\n");
}

main().catch((e) => { console.error(`\n❌ Advisor capture failed: ${e.message}\n`); process.exit(1); });
