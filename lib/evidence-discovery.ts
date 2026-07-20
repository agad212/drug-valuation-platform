// ═══════════════════════════════════════════════════════════════════════════
// True Effect Prior — Evidence Discovery
// ═══════════════════════════════════════════════════════════════════════════
//
// AI-driven discovery for the three evidence sources in lib/effect-prior.ts
// that require a fresh search: animal/preclinical data, same-target "analog"
// clinical data, and the drug's own clinical data. Each function calls Claude
// with web search and translates findings into {mu, sigma2} on the same scale
// as effect-prior.ts (mu ~ mss*2, range 0-2; sigma2 ~ variance, range 0.05-0.8).
//
// The fourth source, "mechanism," needs no search — buildMechanismStep() seeds
// it directly from the already-computed Layer 1 scoreMechanism() result.
// ═══════════════════════════════════════════════════════════════════════════

import { callClaudeWithSearch } from "./claudeSearch";
import type { EvidenceStepInput, EvidenceSourceType, ClassStatus } from "./effect-prior";

export type EvidenceContext = {
  drug: string;
  indication?: string;
  phase?: string;
  sponsor?: string;
  nctId?: string;
  /** scoreMechanism().summary — gives discovery prompts context on what the mechanism IS. */
  mechanismSummary: string;
};

// ─── Mechanism step — pure, no API call ──────────────────────────────────────

export function buildMechanismStep(mechanism: {
  mss: number;
  variance: number;
  summary: string;
}): EvidenceStepInput {
  return {
    source: "mechanism",
    label: "Mechanism & pharmacology",
    found: true,
    signal: { mu: mechanism.mss * 2, sigma2: mechanism.variance },
    reasoning: mechanism.summary,
  };
}

// ─── Shared scale-calibration prompt fragment ────────────────────────────────
// Anchored to the same MSS strength bands as ptrs-mechanism-scorer.ts so mu/sigma2
// stay consistent across all evidence sources.

const SCALE_CALIBRATION = `SCALE — "mu" and "sigma2" (same units used throughout this platform):

mu = 2 × (an MSS-equivalent score, 0-1, for THIS EVIDENCE ALONE)
  CONFIRMING evidence anchors:
    ~0.20 (mu≈0.4)  poor / below-average — notably below expectations (e.g., marginal effect in weak model)
    ~0.50 (mu≈1.0)  average / typical — a normal, unremarkable result
    ~0.65 (mu≈1.3)  above-average — clearly positive
    ~0.80 (mu≈1.6)  strong / best-in-class — exceptional
  Strong positive evidence (large n, consistent effect, indication-matched) → HIGH mu + LOW sigma2.

  DISCONFIRMING evidence — these are NOT "weak" results; they are STRONG NEGATIVE signals:
    Serial class failures (3+ programs, no pivotal success, class graveyard):
      → mu in 0.10–0.35 — this is strong negative evidence. A class that has serially failed
        in Phase 2/3 does NOT produce mu near 1.0. It produces mu well below 0.5.
    Stable disease only, zero ORR in a solid-tumor ORR endpoint:
      → mu in 0.25–0.45 — stable disease in a setting where ORR is the gate is near-failure.
        Do NOT score this as "average" (mu≈1.0). It is a weak efficacy signal.
    Null / wrong-direction own data:
      → mu in 0.10–0.35 depending on severity.

sigma2 = how much CONFIDENCE this evidence gives us about the drug's true effect.
  LOW sigma2 = HIGH confidence (we know clearly, in either direction).
  HIGH sigma2 = LOW confidence (small, indirect, or ambiguous).

  CONFIRMING evidence:
    0.05-0.10  large, consistent, directly-relevant dataset
    0.15-0.30  typical single study, moderately-relevant analog
    0.40-0.80  small/early/indirect/anecdotal data, loosely-relevant analog

  DISCONFIRMING evidence — sigma2 must reflect CONFIDENCE IN THE NEGATIVE, not just sample size:
    3+ consistent class failures, well-documented:
      → sigma2 0.08–0.15 (MANY consistent negatives = HIGH confidence they're negative = LOW sigma2)
    1-2 failures, or early-stage failures only:
      → sigma2 0.20–0.35
    Single failing analog with weak relevance:
      → sigma2 0.40-0.60
  CRITICAL: Do NOT give a class graveyard sigma2 = 0.6. That would barely move the prior.
  Multiple consistent documented failures → LOW sigma2 (high confidence) → strong downward pull.

SYMMETRY RULE: Strong confirming evidence → HIGH mu, LOW sigma2 (strong upward pull).
Strong disconfirming evidence → LOW mu, LOW sigma2 (strong downward pull). This is intentional
and correct — the engine is calibrated to move in BOTH directions, not just the optimistic one.
Both must be valid JSON numbers. Clamp mu to [0,2] and sigma2 to [0.05,0.8] yourself.`;

// ─── System prompts ───────────────────────────────────────────────────────────

const ANIMAL_SYSTEM_PROMPT = `You are a pharmacology researcher assessing animal-model evidence for a drug development probability model.

${SCALE_CALIBRATION}

YOUR TASK — ANIMAL/PRECLINICAL EVIDENCE:
Search for in vivo animal data on this drug (efficacy in disease models — xenograft, transgenic, dose-response vs. standard-of-care — and/or safety/tolerability that bears on whether the drug can be dosed high enough to be effective).

REASONING GUIDANCE:
- mu reflects how strong/consistent the effect was vs. controls and vs. what you'd expect for this mechanism.
- sigma2 reflects how directly this evidence speaks to "will this work in humans": a well-validated disease model with a clean dose-response → lower sigma2 (0.10-0.20). A tolerability-only study with no efficacy readout, or a non-standard model → higher sigma2 (0.4-0.8) even if the mu estimate looks reasonable.
- If you find ONLY safety/tolerability data with no efficacy signal, found may still be true with a wide sigma2 — be explicit that the signal is indirect.

found: false IS APPROPRIATE WHEN:
- No animal/preclinical data of any kind is publicly available for this molecule.
- The only "animal" references are generic statements about the drug class/target in OTHER molecules, not this drug — that belongs in "analog," not here.

Use web_search before answering.

RESPOND WITH ONLY THIS JSON:
{
  "found": true | false,
  "label": "short label, e.g. 'Animal model: xenograft efficacy study' or 'Animal model: tolerability only'",
  "mu": 0.0,
  "sigma2": 0.0,
  "reasoning": "2-4 sentences: what data you found (or didn't), what model/study, and why this mu/sigma2."
}
If found is false, omit mu/sigma2 and explain what you searched for and why nothing usable was found.`;

const ANALOG_SYSTEM_PROMPT = `You are a pharmaceutical competitive-intelligence analyst assessing same-target/same-mechanism analog evidence for a drug development probability model.

${SCALE_CALIBRATION}

YOUR TASK (three explicit steps):

STEP 1 — IDENTIFY CANDIDATES in a FIXED, DETERMINISTIC order. You MUST evaluate ALL THREE tiers every time — do NOT stop after tier 1, and do NOT let "no same-target drug exists" end the search. This determinism matters: the same drug must produce the same evidence set on every run.
  TIER 1 — SAME MOLECULAR TARGET: other drugs against the identical target (e.g. other anti-miR-10b agents).
  TIER 2 — SAME MODALITY-CLASS (REQUIRED, even if tier 1 is empty): all drugs of the same therapeutic modality in oncology, regardless of the specific target — e.g. for an anti-miRNA/antisense-oligonucleotide anti-cancer drug, this means the ENTIRE anti-miRNA / therapeutic-oligonucleotide oncology class (Cobomarsen/anti-miR-155, MRX34/miR-34a mimic, and any other miRNA-directed cancer programs). A first-in-class TARGET is NOT a first-in-class MODALITY — the modality-class track record is ADMISSIBLE and REQUIRED evidence.
  TIER 3 — SAME BROAD PATHWAY: same-pathway/different-target drugs.
Consider both successes AND failures at every tier — a track record of failures in the modality-class is just as informative as successes.

STEP 2 — SCORE RELEVANCE of each candidate on three axes: target (same target > same pathway > same broad class), indication (same disease > related pathophysiology > different), modality (same drug type — small molecule/mAb/ADC/gene therapy — > related > very different).

STEP 3 — SYNTHESIZE:
- mu: what does the analog track record suggest about likely effect size for THIS drug's mechanism?
  * Class with repeated clinical success → mu 0.9-1.5 (higher is better)
  * CLASS GRAVEYARD (3+ programs failed/discontinued, no pivotal success in class) → mu in 0.10-0.35.
    This is STRONG NEGATIVE EVIDENCE. If no drug in this mechanism class has ever succeeded in
    Phase 2/3, that is not a "5-point nudge" situation — it is a class-level signal of likely
    failure that should substantially pull the prior DOWN. Do NOT soften this.
  * Mixed track record (some successes, some failures) → mu 0.5-0.8
  * This evidence's job is to potentially CONFLICT with the mechanism story — don't suppress that conflict.

- sigma2: determined by NUMBER and CONSISTENCY of analog data points, not just "is this indirect":
  * 3+ consistent class failures (well-documented, different companies) → sigma2 0.08-0.15
    (multiple consistent negatives = HIGH CONFIDENCE = LOW sigma2 = STRONG downward pull)
  * 1-2 failures, or mixed → sigma2 0.20-0.35
  * Single analog, or very different indication → sigma2 0.40-0.60
  CRITICAL: A class graveyard with 4+ documented Phase 2+ failures must NOT get sigma2 0.6.
  Your confidence in that negative signal is HIGH, so sigma2 must be LOW (0.08-0.15).

found: false IS APPROPRIATE ONLY WHEN ALL THREE tiers are genuinely empty — no same-target drug, no same-modality-class drug, and no same-pathway drug has ANY clinical outcome data. This is rare.
- CRITICAL: do NOT report found:false on the grounds that "no SAME-TARGET analog exists" (tier 1 empty) if the MODALITY-CLASS (tier 2) has clinical programs. If the drug is an anti-miRNA/oligonucleotide oncology agent and ANY miRNA-directed cancer program has clinical data (e.g. Cobomarsen, MRX34), found MUST be true and reflect that class track record. "First-in-class target" is NOT grounds for found:false when the modality-class has a track record.
- found:false is reserved for a drug whose modality-class itself has never entered the clinic in oncology.
Do NOT force a finding from an unrelated category (e.g. "also injectable") with no mechanistic connection — that is noise. But a real modality-class track record is signal and MUST be reported.

CLASS FACTS — REQUIRED. Report the STRUCTURED, COUNTABLE facts about the class (these
are read downstream by a DETERMINISTIC rule that prices class base-rate risk — report
FACTS, not a gestalt judgment, so the same evidence always yields the same risk):
- classFailures: integer count of DOCUMENTED same-target/same-class clinical FAILURES or
  terminations at Phase 2 or later across all sponsors (0 if none).
- classApprovals: integer count of APPROVED or clearly precedented members of the class (0 if none).
- differentiatedSubMechanismWithPOC: true ONLY if THIS drug uses a mechanistically
  DISTINCT sub-mechanism (e.g. a different epitope/target domain than the failed analogs)
  AND that sub-mechanism has its own human proof-of-concept / target-engagement signal;
  false otherwise. Be conservative — a mere "novel" claim without human POC is false.
Also give classStatus as your gestalt label ("graveyard"|"precedent"|"mixed"|"none") for
readability, but the FACTS above are what drive the math. Be consistent with your mu.

Use web_search before answering.

RESPOND WITH ONLY THIS JSON:
{
  "found": true | false,
  "label": "e.g. 'Same-target analogs: <Drug A>, <Drug B> clinical outcomes'",
  "classStatus": "graveyard" | "precedent" | "mixed" | "none",
  "classFailures": 0,
  "classApprovals": 0,
  "differentiatedSubMechanismWithPOC": true | false,
  "mu": 0.0,
  "sigma2": 0.0,
  "reasoning": "3-5 sentences: which analog(s), their relevance (target/indication/modality match), their outcomes, the failure/approval COUNTS, whether this drug is a differentiated sub-mechanism with POC, and how that became this mu/sigma2."
}
If found is false, explain which candidates you considered and why none were usable.`;

const OWN_CLINICAL_SYSTEM_PROMPT = `You are a clinical development analyst assessing a drug's own reported clinical trial results for a drug development probability model.

${SCALE_CALIBRATION}

YOUR TASK: search for THIS drug's own clinical results (Phase 1/1b/2/interim 3 — press releases, conference presentations, CT.gov results postings). Focus on EFFICACY signals: response rates, biomarker changes consistent with mechanism, time-to-event endpoints — anything speaking to whether the drug DOES WHAT THE MECHANISM PREDICTS in humans.

REASONING GUIDANCE:
- mu reflects how strong the observed effect was vs. what you'd expect for this mechanism/indication:
  * Clearly above historical controls/SOC → mu 0.9-1.6 (higher = stronger)
  * Roughly in line with SOC → mu 0.7-1.0
  * STABLE DISEASE ONLY, ZERO OBJECTIVE RESPONSES in a solid-tumor ORR-gated trial:
    → mu in 0.25-0.45. Stable disease in a context where ORR is the approval gate is
      near-failure for the efficacy bar. Do NOT score it as "average" (mu≈1.0). It is a weak
      positive at best, near-negative in most regulatory contexts. Score it accordingly.
  * Flat/null/wrong-direction: mu 0.10-0.35

ASYMMETRY — A NULL/NEGATIVE EFFICACY SIGNAL IS INFORMATION, NOT UNCERTAINTY:
  If the drug's OWN trial produced a null or negative efficacy result — zero objective responses in
  an ORR-gated setting, no separation from control, stable-disease-only where responses were the
  readout — that is INFORMATIVE-NEGATIVE evidence, not "we don't know." Keep mu LOW (0.25-0.45) and
  sigma2 MODERATE (0.20-0.40) so it produces a REAL downward pull on the prior. Do NOT regress mu UP
  toward the base rate, and do NOT inflate sigma2 to 0.55-0.70 — that would treat a negative result
  as mere uncertainty and neutralize it, which is exactly wrong. (Same principle as class-graveyard
  analog evidence: a consistent negative = HIGH confidence in the negative = LOW sigma2 = strong pull.)

- sigma2 reflects sample size/maturity AND any translation gap (see below):
  * Large/mature/controlled trial → sigma2 0.10-0.25
  * Small early cohort (n<30, short follow-up) → sigma2 0.40-0.65
  * BUT a null/negative efficacy signal overrides the "small cohort = high sigma2" default per the
    ASYMMETRY rule above — a negative result from a small trial is still informative-negative.

INDICATION/ENDPOINT MISMATCH — ALWAYS REASON ABOUT THIS:
  Compare the setting and endpoint of the evidence you found to the indication being VALUED.
  The mismatch rules below apply to a POSITIVE cross-setting result (a good result elsewhere is
  uncertain here → regress mu toward base rate, widen sigma2). They do NOT apply to a NEGATIVE
  result — a negative signal stays negative (see ASYMMETRY above); a mismatch may add at most
  +0.10-0.15 sigma2 (somewhat less determinative cross-setting) but never flips it to "no information."

  HIGH translation gap for a POSITIVE result (large sigma2 penalty + mu regression):
  - Evidence: a POSITIVE RECIST response / ORR in measurable METASTATIC disease
    Indication valued: ctDNA clearance / MRD negativity / biomarker clearance in POST-SURGERY
    minimal-residual-disease setting (no measurable disease, RECIST doesn't apply)
    → sigma2 += 0.25-0.35 (push sigma2 to 0.55-0.70 even for small n).
      mu → pull toward 0.6-0.85 (these settings have different biology; a positive metastatic ORR
      tells you little about whether the drug can clear microscopic residual disease).
  - Evidence: any mixed-histology basket cohort
    Indication valued: single specific tumor type
    → sigma2 += 0.15-0.20; mild mu regression

  MODERATE translation gap:
  - Evidence: same tumor type, different line of therapy
    → sigma2 += 0.10-0.15

  LOW / NO translation gap:
  - Evidence: same tumor type, same line, same endpoint type as indication being valued
    → No adjustment; use evidence directly

  STATE EXPLICITLY whether a mismatch exists, what it is, and how it changed your sigma2/mu.

EFFICACY SIGNAL CLASSIFICATION — REQUIRED (this label deterministically bounds the score downstream):
- "null_negative": zero objective responses (ORR=0) in a trial where objective response was an
  efficacy readout, OR no separation from control, OR stable-disease-only where responses were the
  readout. STABLE DISEASE IS NOT AN OBJECTIVE RESPONSE — "0 ORR, 64% stable disease" is null_negative,
  NOT positive and NOT "no data." A cross-setting/endpoint mismatch does NOT change this label (it may
  add some sigma2, but a null efficacy result is still null_negative).
- "positive": objective responses (PR/CR) observed, clear separation from control, or a positive
  time-to-event / biomarker-clearance result.
- "not_measurable_yet": only safety/PK/tolerability reported, no efficacy readout at all (also set found:false).

found: false IS APPROPRIATE WHEN:
- No clinical efficacy data reported yet (still Phase 1 dose-escalation with only safety/PK/tolerability, or Preclinical).
- Reported data is purely PK/PD/target-engagement with NO clinical efficacy readout — set found:false even if PK data exists. (This keeps "own clinical efficacy" cleanly separate from mechanism/animal evidence, which already cover target-engagement signals.)

Use web_search before answering.

RESPOND WITH ONLY THIS JSON:
{
  "found": true | false,
  "label": "e.g. 'Own clinical data: Phase 1b efficacy (n=24)'",
  "efficacySignal": "positive" | "null_negative" | "not_measurable_yet",
  "mu": 0.0,
  "sigma2": 0.0,
  "reasoning": "2-4 sentences: what trial/data (phase, n, endpoint, result), and why this mu/sigma2 — or why no efficacy data exists yet."
}`;

// ─── Shared helpers ─────────────────────────────────────────────────────────

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/** 2 attempts total; 30s wait before retrying a 429, else 5s. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const is429 = typeof e?.message === "string" && e.message.includes("429");
    await new Promise((r) => setTimeout(r, is429 ? 30000 : 5000));
    return await fn();
  }
}

function parseDiscoveryResponse(raw: string): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Claude response");
  return JSON.parse(match[0]);
}

function toEvidenceStep(source: EvidenceSourceType, defaultLabel: string, parsed: any): EvidenceStepInput {
  const label = typeof parsed?.label === "string" && parsed.label ? parsed.label : defaultLabel;
  const reasoning =
    typeof parsed?.reasoning === "string" && parsed.reasoning ? parsed.reasoning : "No reasoning provided.";

  if (
    !parsed?.found ||
    typeof parsed.mu !== "number" ||
    typeof parsed.sigma2 !== "number" ||
    !Number.isFinite(parsed.mu) ||
    !Number.isFinite(parsed.sigma2)
  ) {
    return { source, label, found: false, reasoning };
  }

  return {
    source,
    label,
    found: true,
    signal: { mu: clamp(parsed.mu, 0, 2), sigma2: clamp(parsed.sigma2, 0.05, 0.8) },
    reasoning,
  };
}

function degradedStep(source: EvidenceSourceType, defaultLabel: string, error: unknown): EvidenceStepInput {
  const message = error instanceof Error ? error.message : String(error);
  return { source, label: defaultLabel, found: false, reasoning: `Evidence search failed: ${message}` };
}

function buildUserMessage(ctx: EvidenceContext): string {
  return `Drug: ${ctx.drug}
Mechanism of action: ${ctx.mechanismSummary}
Indication: ${ctx.indication || "unknown"}
Development phase: ${ctx.phase || "unknown"}${ctx.sponsor ? `\nSponsor: ${ctx.sponsor}` : ""}${ctx.nctId ? `\nClinicalTrials.gov ID: ${ctx.nctId}` : ""}

Use web_search to research this drug, then respond with the JSON described in your instructions.`;
}

// ─── Discovery functions ───────────────────────────────────────────────────

export async function discoverAnimalEvidence(ctx: EvidenceContext, anthropicKey: string): Promise<EvidenceStepInput> {
  const source: EvidenceSourceType = "animal";
  const defaultLabel = "Animal/preclinical evidence";
  try {
    const raw = await withRetry(() =>
      callClaudeWithSearch({
        anthropicKey,
        system: ANIMAL_SYSTEM_PROMPT,
        userMessage: buildUserMessage(ctx),
        maxTokens: 1500,
        maxSearches: 2,
        serperQueries: [`${ctx.drug} animal model preclinical efficacy data`],
      })
    );
    return toEvidenceStep(source, defaultLabel, parseDiscoveryResponse(raw));
  } catch (e) {
    return degradedStep(source, defaultLabel, e);
  }
}

export async function discoverAnalogEvidence(ctx: EvidenceContext, anthropicKey: string): Promise<EvidenceStepInput> {
  const source: EvidenceSourceType = "analog";
  const defaultLabel = "Same-target analog clinical data";
  try {
    const raw = await withRetry(() =>
      callClaudeWithSearch({
        anthropicKey,
        system: ANALOG_SYSTEM_PROMPT,
        userMessage: buildUserMessage(ctx),
        maxTokens: 1500,
        maxSearches: 3,
        serperQueries: [
          `${ctx.drug} competitor drugs same target mechanism clinical trials`,
          `${ctx.indication || ctx.drug} drugs same mechanism clinical trial results failures`,
        ],
      })
    );
    const parsed = parseDiscoveryResponse(raw);
    const step = toEvidenceStep(source, defaultLabel, parsed);
    // Capture the analog step's modality/target-class determination so the dev
    // plan can price the class base rate on the stage probabilities too.
    const VALID: ReadonlyArray<ClassStatus> = ["graveyard", "precedent", "mixed", "none"];
    step.classStatus = VALID.includes(parsed?.classStatus) ? parsed.classStatus : undefined;
    // Part 2: capture the STRUCTURED class facts (drive the deterministic p_graveyard).
    // Only attach when at least one countable fact is present, so a model that omits
    // them cleanly falls back to the classStatus label downstream.
    const failures = Number(parsed?.classFailures);
    const approvals = Number(parsed?.classApprovals);
    if (Number.isFinite(failures) || Number.isFinite(approvals)) {
      step.classEvidence = {
        sameTargetFailures: Number.isFinite(failures) ? Math.max(0, Math.trunc(failures)) : 0,
        approvedInClass: Number.isFinite(approvals) ? Math.max(0, Math.trunc(approvals)) : 0,
        differentiatedSubMechanismWithPOC: parsed?.differentiatedSubMechanismWithPOC === true,
      };
    }
    return step;
  } catch (e) {
    return degradedStep(source, defaultLabel, e);
  }
}

export async function discoverOwnClinicalEvidence(
  ctx: EvidenceContext,
  anthropicKey: string
): Promise<EvidenceStepInput> {
  const source: EvidenceSourceType = "own_clinical";
  const defaultLabel = "Drug's own clinical data";
  try {
    const raw = await withRetry(() =>
      callClaudeWithSearch({
        anthropicKey,
        system: OWN_CLINICAL_SYSTEM_PROMPT,
        userMessage: buildUserMessage(ctx),
        maxTokens: 1500,
        maxSearches: 2,
        serperQueries: [`${ctx.drug} clinical trial results efficacy data`],
      })
    );
    const parsed = parseDiscoveryResponse(raw);
    return boundNullNegativeSignal(toEvidenceStep(source, defaultLabel, parsed), parsed);
  } catch (e) {
    return degradedStep(source, defaultLabel, e);
  }
}

/**
 * Deterministic enforcement of the own-clinical asymmetry rule. The prose rule
 * (a null/negative efficacy result is INFORMATION, not uncertainty) did not bind
 * at runtime — the model kept regressing mu to the base rate and inflating sigma2
 * to ~0.52 via the setting-mismatch, neutralizing a zero-ORR result. When the
 * model classifies the signal as null_negative, we CLAMP it here to a bounded
 * informative-negative range: mu ∈ [0.30, 0.45] (a real downward pull, but not
 * cratered — stable disease is real and ctDNA was unmeasured), sigma2 ∈ [0.25,
 * 0.42] (the mismatch cannot inflate it into "no information"). This preserves
 * displayed==consumed: the clamped sigma2 is the one stored on the step and shown.
 */
export function boundNullNegativeSignal(step: EvidenceStepInput, parsed: any): EvidenceStepInput {
  if (step.found && step.signal && parsed?.efficacySignal === "null_negative") {
    return {
      ...step,
      signal: {
        mu: clamp(step.signal.mu, 0.30, 0.45),
        sigma2: clamp(step.signal.sigma2, 0.25, 0.42),
      },
    };
  }
  return step;
}
