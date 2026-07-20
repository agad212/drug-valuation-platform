/*
 * scripts/capture-fixture.ts — STANDALONE fixture capture (Option B).
 *
 * Never imported by production. Replays the EXACT live API orchestration
 * (index.tsx onAutoValue → lead-reasoner → ptrs-score → effect-prior →
 * ptrs-layer2 → dev-plan) against a RUNNING dev server, hitting the same routes
 * with the same payloads and the same models — so the captured inputs are
 * FAITHFUL to a real run, not reconstructed. It then runs the same deterministic
 * chain the harness uses (runDeterministicChain/headline) to write the golden
 * `expected` block, guaranteeing the harness reproduces the fixture.
 *
 * This makes REAL LLM/retrieval calls — the accepted one-time API cost. It edits
 * ZERO live-path files; the only new artifact is the emitted JSON fixture.
 *
 * USAGE (server must be running; run from the repo root):
 *   npm run dev                                  # terminal 1
 *   npx tsx scripts/capture-fixture.ts --drug "TTX-MC138" --phase "Phase 2"
 *   npx tsx scripts/capture-fixture.ts --drug "BMS-986446" --phase "Phase 2" --sponsor "Bristol Myers Squibb"
 *
 * Flags: --drug (required) --phase --sponsor --base (default http://localhost:3000)
 *        --no-revenue (skip the revenue-assumptions refine call) --out <path>
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDeterministicChain, headline, type Fixture } from "../tests/harness/fixture-runner";
import { inferTherapeuticArea, inferModality, classifyComps } from "../lib/financial-pins";
import type { EvidenceStepInput } from "../lib/effect-prior";
import type { DevStageInput } from "../lib/dev-plan";

// The harness pins the clock to this date; pin identically so `expected` matches.
const HARNESS_AS_OF = "2026-07-01T00:00:00Z";

// ── CLI ─────────────────────────────────────────────────────────────────────
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
const doRevenue = args["no-revenue"] !== true;
if (!drug) { console.error("ERROR: --drug is required"); process.exit(1); }

const phaseNum = (p: string) => (p.includes("3") ? 3 : p.includes("2") ? 2 : p.includes("1") ? 1 : 0);
// Same rule as lib/ctgov.isEnrollmentComplete (inlined to avoid importing the connector).
const isEnrollmentComplete = (status?: string) =>
  !!status && /COMPLETED|ACTIVE_NOT_RECRUITING|ENROLLING_BY_INVITATION/i.test(status);

async function getJSON(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}
async function postJSON(path: string, payload: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// Pin Date so computeRevenuePV / impliedLaunchYear match the harness exactly.
// Function-based mock (typed any) to sidestep Date-subclass typing.
function withPinnedDate<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  const fixedMs = RealDate.parse(iso);
  const Mock: any = function (this: unknown, ...a: any[]) {
    return a.length ? new (RealDate as any)(...a) : new RealDate(fixedMs);
  };
  Mock.now = () => fixedMs;
  Mock.parse = RealDate.parse.bind(RealDate);
  Mock.UTC = RealDate.UTC.bind(RealDate);
  Mock.prototype = RealDate.prototype;
  (globalThis as any).Date = Mock;
  try { return fn(); } finally { (globalThis as any).Date = RealDate; }
}

const round = (x: number, p = 5) => (x == null ? x : Math.round(x * 10 ** p) / 10 ** p);

async function main() {
  console.log(`\n▶ Capturing fixture for "${drug}" via ${BASE} (real LLM/retrieval calls)…\n`);

  // 1 ── auto-value: trials, financials, recommended NCT, mechanism ─────────────
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

  // 2 ── lead-reasoner: the governing brief (indication, stage, SOC rate) ────────
  const lr = await postJSON(`/api/lead-reasoner`, { drug, sponsor, phase, mechanism, indication: av.indications[0]?.name });
  const brief = lr.brief;
  if (!brief) throw new Error("lead-reasoner returned no brief (HARD GATE in the live path)");
  const briefIndication = brief.base_case_indication?.value || av.indications[0]?.name || "";
  const ptrsPhase = brief.true_stage?.value || phase;
  const briefSocRR = brief.soc_response_rate?.value;
  const efficacyGateNct = brief.efficacy_gate_trial?.trial_id;
  console.log(`  ✓ lead-reasoner: indication="${briefIndication}", stage="${ptrsPhase}", SOC=${briefSocRR ?? "—"}`);

  // 3 ── ptrs-score (Layer 1 mechanism): mss, variance, summary, ptrs, CI ────────
  const l1 = await postJSON(`/api/ptrs-score`, { drug, mechanism, indication: briefIndication, phase: ptrsPhase, sponsor });
  const ciHalfWidth = l1.ptrsCI ? (l1.ptrsCI.upper - l1.ptrsCI.lower) / 2 : 0.10;
  console.log(`  ✓ ptrs-score: mss=${round(l1.mss)}, variance=${round(l1.variance)}, ciHalfWidth=${round(ciHalfWidth)}`);

  // NCT matching, mirroring index.tsx (effect-prior + layer2 + dev-plan).
  const matchingTrial = trials.find((t) => phaseNum(t.phase || "") >= phaseNum(ptrsPhase));
  const priorNctId = matchingTrial?.nctId;
  const layer2Nct = efficacyGateNct || matchingTrial?.nctId;
  const currentTrial = trials.find((t) => t.nctId === recommendedNctId) || matchingTrial;
  const enrollmentComplete = isEnrollmentComplete(currentTrial?.status);
  const currentTrialCompletionDate = currentTrial?.primaryCompletionDate ?? currentTrial?.completionDate;

  // 4 ── effect-prior: the evidence chain (mechanism→animal→analog→own_clinical) ─
  const ep = await postJSON(`/api/effect-prior`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor, nctId: priorNctId,
    mechanism: { mss: l1.mss, variance: l1.variance, summary: l1.summary },
  });
  const chain = ep.effectPrior?.chain;
  if (!chain?.length) throw new Error("effect-prior returned no chain");
  // Extract exactly the EvidenceStepInput fields buildEffectPrior consumes.
  const chainSteps: EvidenceStepInput[] = chain.map((s: any) => ({
    source: s.source, label: s.label, found: s.found,
    ...(s.found && s.signal ? { signal: { mu: s.signal.mu, sigma2: s.signal.sigma2 } } : {}),
    ...(s.classStatus ? { classStatus: s.classStatus } : {}),
    ...(s.classEvidence ? { classEvidence: s.classEvidence } : {}), // Part 2: structured class facts
    reasoning: s.reasoning ?? "",
  }));
  console.log(`  ✓ effect-prior: ${chainSteps.length} steps, analog classStatus="${chainSteps.find((s) => s.source === "analog")?.classStatus ?? "—"}"`);

  // 5 ── ptrs-layer2: the current-trial design (feeds the dev plan) ──────────────
  const l2 = await postJSON(`/api/ptrs-layer2`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor, nctId: layer2Nct,
    layer1: { mss: l1.mss, variance: l1.variance, ptrs: l1.ptrs, ciHalfWidth },
  });
  if (!l2.trialInputs) throw new Error("ptrs-layer2 returned no trialInputs");

  // 6 ── dev-plan: the staged plan (post-pin, post-parse) ────────────────────────
  const dp = await postJSON(`/api/dev-plan`, {
    drug, indication: briefIndication, phase: ptrsPhase, sponsor,
    currentTrialDesign: l2.trialInputs, currentTrialName: drug,
    currentTrialEnrollmentComplete: enrollmentComplete,
    currentTrialCompletionDate,
  });
  if (!dp.stages?.length) throw new Error("dev-plan returned no stages");
  // Back-fill nullResponseRate from the brief SOC rate, exactly as index.tsx does.
  const stages: DevStageInput[] = (dp.stages as DevStageInput[]).map((s) => ({
    ...s, nullResponseRate: s.nullResponseRate ?? briefSocRR,
  }));
  console.log(`  ✓ dev-plan: ${stages.length} stage(s), regContext="${dp.regulatoryContext}", enrollmentComplete=${enrollmentComplete}`);

  // 7 ── revenue inputs + retrieved comps (for the peak-sales anchor, Fix #2) ─────
  let peakSales = av.indications[0]?.peakSales || 0;
  let comps: { drug: string; peakSalesM: number }[] = [];
  if (doRevenue) {
    try {
      const rev = await postJSON(`/api/revenue-assumptions`, {
        drug, phase: ptrsPhase, indications: [briefIndication], sponsor,
      });
      const ind0 = rev.indications?.[0];
      const m = ind0?.peakSalesM;
      if (m && m > 0) { peakSales = Math.round(m * 1e6); }
      comps = (ind0?.comps || [])
        .filter((c: any) => c && c.peakSalesM > 0)
        .map((c: any) => ({ drug: c.drug, peakSalesM: c.peakSalesM }));
      console.log(`  ✓ revenue-assumptions: peakSales=$${(peakSales / 1e6).toFixed(0)}M, ${comps.length} comps`);
    } catch (e: any) {
      console.warn(`  ! revenue-assumptions failed (${e.message}); using auto-value peakSales, no comps`);
    }
  }
  const defaultLaunch = new Date().getFullYear() + 7;
  const launchYear = av.indications[0]?.launchYear ?? defaultLaunch;
  const valuation = {
    peakSales,
    launchYear,
    loeYear: av.loeYear ?? launchYear + 10,
    // App defaults (DEFAULT_VALUATION in index.tsx); user hasn't edited in an auto-run.
    discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1, avgRoyalty: 0.15,
    ownerType: "Owner" as const,
  };

  // ── Assemble fixture + compute golden `expected` via the SAME runner the harness uses ──
  const analogClass = chainSteps.find((s) => s.source === "analog")?.classStatus ?? null;
  const fx: Fixture = {
    meta: {
      asset: drug,
      capturedAt: new Date().toISOString().slice(0, 10),
      note: `CAPTURED from a live run via scripts/capture-fixture.ts (faithful inputs, not reconstructed). Base=${BASE}. Expected values computed at the harness reference date ${HARNESS_AS_OF}.`,
      expectedHeadline: {
        pApprovalBand: [0, 1], // set below from the actual
        classStatus: analogClass,
        appliesModalityHaircut: analogClass === "graveyard",
      },
    },
    ciHalfWidth,
    chainSteps,
    devPlan: {
      regulatoryContext: dp.regulatoryContext ?? "standard", regCostM: 1.0, stages,
      orphanConfirmedForIndication: l2.orphanConfirmedForIndication === true, // Fix B
    },
    financial: {
      therapeuticArea: inferTherapeuticArea(briefIndication),
      modality: inferModality(mechanism),
      // Real patent LOE only when auto-value derived a patent-basis date; else null → labeled rule.
      patentLoeYear: av.loeBasis === "patent" ? (av.loeYear ?? null) : null,
      comps: classifyComps(comps),
    },
    valuation,
  };

  const h = withPinnedDate(HARNESS_AS_OF, () => headline(runDeterministicChain(fx)));
  const p = h.pApproval;
  fx.meta.expectedHeadline.pApprovalBand = [Math.max(0, round(p - 0.1, 3)), Math.min(1, round(p + 0.1, 3))];
  fx.expected = Object.fromEntries(
    Object.entries(h).filter(([, val]) => val != null).map(([k, val]) => [k, round(val as number, 5)]),
  ) as Record<string, number>;

  const slug = drug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outPath = (args.out as string) || resolve(process.cwd(), "tests", "fixtures", `${slug}.fixture.json`);
  writeFileSync(outPath, JSON.stringify(fx, null, 2) + "\n", "utf-8");

  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   HEADLINE @ ${HARNESS_AS_OF}: P(approval)=${(p * 100).toFixed(1)}%  finalMss=${round(h.finalMss, 3)}  launch=${h.impliedLaunchYear}  eNPV=$${h.eNPVM}M  eROI=${h.eROI}`);
  console.log(`   classStatus=${analogClass ?? "—"}  haircut=${fx.meta.expectedHeadline.appliesModalityHaircut ? "0.80" : "1.0"}\n`);
  console.log(`   Next: npx vitest run tests/harness   (the harness now reproduces this fixture offline)\n`);
}

main().catch((e) => { console.error(`\n❌ Capture failed: ${e.message}\n`); process.exit(1); });
