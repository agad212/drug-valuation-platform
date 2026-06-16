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
import type { EvidenceStepInput, EvidenceSourceType } from "./effect-prior";

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
  Anchors (apply ONLY to the evidence you found, not the drug overall):
    ~0.20 (mu≈0.4)  weak / below-average — modest effect size, marginal significance
    ~0.50 (mu≈1.0)  average / typical — a normal, unremarkable result for this evidence type
    ~0.65 (mu≈1.3)  above-average — clearly positive, better than the typical case
    ~0.80 (mu≈1.6)  strong / best-in-class — exceptional, top-tier result
  Most real evidence lands between mu=0.6 and mu=1.4. Reserve the extremes (mu<0.4 or mu>1.7)
  for evidence that is unambiguously poor or unambiguously outstanding.

sigma2 = how much uncertainty this evidence carries as a signal about the DRUG'S TRUE EFFECT
(not just statistical uncertainty in the study itself — also how directly this evidence
speaks to the question):
    0.05-0.10  large, consistent, directly-relevant dataset
    0.15-0.30  typical single study, or a moderately-relevant analog
    0.40-0.80  small/early/indirect/anecdotal data, or a loosely-relevant analog

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

STEP 1 — IDENTIFY CANDIDATES: search for OTHER drugs (approved, failed, or in development) that share meaningful biological overlap with this drug's mechanism — ideally the same molecular target, but same-pathway/different-target can count too. Consider both successes AND failures — a track record of failures in this target class is just as informative.

STEP 2 — SCORE RELEVANCE of each candidate on three axes: target (same target > same pathway > same broad class), indication (same disease > related pathophysiology > different), modality (same drug type — small molecule/mAb/ADC/gene therapy — > related > very different).

STEP 3 — SYNTHESIZE:
- mu: what does the analog track record suggest about likely effect size for THIS drug's mechanism? A class with repeated clinical success → higher mu. A class with repeated high-profile failures → lower mu — regardless of how good this drug's OWN mechanism score was. This evidence's job is to potentially CONFLICT with the mechanism story.
- sigma2: reflects both consistency across analogs AND their relevance (from Step 2). High relevance + multiple consistent analogs → lower sigma2 (0.10-0.20). Single analog, or relevant on only one axis → higher sigma2 (0.4-0.8).

found: false IS APPROPRIATE WHEN:
- No drugs with meaningful target/pathway overlap have reached a stage with clinical outcome data (genuinely first-in-class target).
- The only "analogs" share nothing beyond the broadest category (e.g. "also a kinase inhibitor") with no real mechanistic connection — reporting these would be noise.
Do NOT force a finding just to have something to report — "no track record yet" is itself useful information (it means the drug's own clinical data carries relatively more weight).

Use web_search before answering.

RESPOND WITH ONLY THIS JSON:
{
  "found": true | false,
  "label": "e.g. 'Same-target analogs: <Drug A>, <Drug B> clinical outcomes'",
  "mu": 0.0,
  "sigma2": 0.0,
  "reasoning": "3-5 sentences: which analog(s), their relevance (target/indication/modality match), their outcomes, and how that became this mu/sigma2."
}
If found is false, explain which candidates you considered and why none were usable.`;

const OWN_CLINICAL_SYSTEM_PROMPT = `You are a clinical development analyst assessing a drug's own reported clinical trial results for a drug development probability model.

${SCALE_CALIBRATION}

YOUR TASK: search for THIS drug's own clinical results (Phase 1/1b/2/interim 3 — press releases, conference presentations, CT.gov results postings). Focus on EFFICACY signals: response rates, biomarker changes consistent with mechanism, time-to-event endpoints — anything speaking to whether the drug DOES WHAT THE MECHANISM PREDICTS in humans.

REASONING GUIDANCE:
- mu reflects how strong the observed effect was vs. what you'd expect for this mechanism/indication: clearly above historical controls/SOC → higher mu; roughly in line with SOC/placebo → mu near 1.0; flat/null/wrong-direction → lower mu.
- sigma2 reflects sample size/maturity: small early cohort (n<30, short follow-up) → higher sigma2 (0.4-0.8) even with a good point estimate. Larger/more mature/controlled → lower sigma2 (0.10-0.25).

found: false IS APPROPRIATE WHEN:
- No clinical efficacy data reported yet (still Phase 1 dose-escalation with only safety/PK/tolerability, or Preclinical).
- Reported data is purely PK/PD/target-engagement with NO clinical efficacy readout — set found:false even if PK data exists. (This keeps "own clinical efficacy" cleanly separate from mechanism/animal evidence, which already cover target-engagement signals.)

Use web_search before answering.

RESPOND WITH ONLY THIS JSON:
{
  "found": true | false,
  "label": "e.g. 'Own clinical data: Phase 1b efficacy (n=24)'",
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
    return toEvidenceStep(source, defaultLabel, parseDiscoveryResponse(raw));
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
    return toEvidenceStep(source, defaultLabel, parseDiscoveryResponse(raw));
  } catch (e) {
    return degradedStep(source, defaultLabel, e);
  }
}
