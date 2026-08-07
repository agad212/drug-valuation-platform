// ─── Dev Plan API ─────────────────────────────────────────────────────────────
//
// POST /api/dev-plan
//
// Claude reasons about the complete remaining development path for a drug:
// what trials are needed, what their design would look like, and what CPP
// (cost per patient) is realistic for each stage.
//
// The current trial's design is already known (from layer2Result.trialInputs).
// Claude only needs to reason about FUTURE stages — typically a Phase 3
// registration study and any bridging/confirmatory studies.
//
// Uses Haiku + Serper (no web_search tool — structured reasoning only).
// Cost: ~$0.003/call.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";
import { logStart, logEnd } from "../../lib/endpoint-timing";
import { parseJsonLoose } from "../../lib/extractJson";
import { pinComparator, pinPhase3Endpoint } from "../../lib/indication-benchmarks";
import { resolveRegulatoryContext } from "../../lib/regulatory-pins";
import type {
  EndpointType,
  DesignType,
  PopulationType,
  PlaceboResponse,
  RegulatoryContext,
  TrialDesignInputs,
} from "../../lib/ptrs-trial";
import type { DevStageInput } from "../../lib/dev-plan";

// ─── CPP reference table (industry benchmarks, Tufts CSDD / BioMedtracker) ───
// Used in the prompt as reference values for Claude to anchor estimates.
// Units: USD per patient enrolled.

const CPP_REFERENCE = `
COST PER PATIENT (CPP) BENCHMARKS — use these as reference, adjust for disease complexity:

Phase 1:
  General / healthy volunteers: $40K–$70K
  Oncology: $60K–$100K
  Rare/orphan: $80K–$140K

Phase 2:
  General / common disease: $60K–$100K
  Oncology: $100K–$180K
  Rare/orphan (specialized centers): $150K–$280K
  Ophthalmology intravitreal (specialized centers): $180K–$300K

Phase 3 / Registration:
  General / common disease: $80K–$140K
  Oncology: $150K–$280K
  Rare/orphan: $250K–$450K
  Ophthalmology / rare ophthalmic: $250K–$420K

Adjust upward for:
  - Rare disease with few eligible centers (+30–50%)
  - Novel/unproven delivery route (+20–30%)
  - Imaging-heavy endpoints (fMRI, OCT, ERG) (+20–40%)
  - Long follow-up periods (+15–25% per additional year)
`;

// ─── Trial duration reference table ──────────────────────────────────────────
// Used in the prompt as reference values for Claude to anchor timeline
// estimates. Pure math in lib/dev-plan.ts then derives enrollmentMonths and
// durationMonths from these per-stage numbers.

const DURATION_REFERENCE = `
TRIAL DURATION BENCHMARKS — use these as reference, adjust for disease specifics:

Enrollment rate (patients enrolled per month, across all sites combined):
  Oncology: 4–10
  Rare/orphan (specialized centers): 1–3
  Ophthalmology (specialized centers): 2–5
  CNS/neurology: 4–8
  Common chronic disease (cardiovascular, metabolic, autoimmune): 8–15
  Infectious disease: 10–20

Treatment / observation period (months — time from a patient's first dose to
their primary-endpoint readout):
  Short (ORR, biomarker, PK/PD, early imaging): 2–6
  Standard (PFS, BCVA at 6-12 months, ACR response, 1-year relapse rate): 6–12
  Long (OS, durability, multi-year relapse/progression): 12–24

Study-startup cushion (site activation, IRB/EC approval, first-patient-in, months):
  Rare disease / specialized sites / novel modality: 6–9
  Common disease / established trial networks: 3–6

Adjust similarly to CPP — rare disease and specialized-site trials enroll more
slowly and take longer to start than common-disease trials at established
networks.

CRITICAL UNIT RULE — treatmentObsMonths, startupCushionMonths and the accrual
implied by enrollmentRatePerMonth are all in MONTHS. Protocols on ClinicalTrials.gov
frequently state periods in WEEKS ("76-week treatment period", "96-week extension").
CONVERT weeks → months by dividing by ~4.345 BEFORE you fill these fields: a 76-week
period is ~18 months (NOT 76), a 96-week period is ~22 months (NOT 96). Never place a
week-count in a month field. A single-phase treatment/observation period above ~36
months is almost never real — re-check whether you mis-read weeks as months.

FULLY-ENROLLED CURRENT TRIAL — if the current trial's status indicates enrollment is
complete (Active-not-recruiting / Completed / Enrolling-by-invitation), its accrual is
already elapsed; the remaining timeline is the treatment/observation readout, not a
fresh multi-year enrollment. For a fully-enrolled trial, use a HIGH enrollmentRatePerMonth
so implied accrual is short — do not project years of future enrollment for patients
who are already on study.
`;

// ─── Handler ──────────────────────────────────────────────────────────────────

type RequestBody = {
  drug: string;
  indication: string;
  phase: string;
  mechanism?: string;
  sponsor?: string;
  currentTrialDesign: TrialDesignInputs;  // from layer2Result.trialInputs
  currentTrialName?: string;              // e.g. "ABACUS-2"
  currentTrialEnrollmentComplete?: boolean; // CT.gov status says the current trial is
                                          //   fully enrolled → 0 remaining accrual time
  currentTrialCompletionDate?: string;    // CT.gov primary-completion date (ISO) — for a
                                          //   fully-enrolled trial, drives remaining duration
};

type StageOutput = {
  id: string;
  name: string;
  phase: string;
  n: number;
  cpp: number;
  isCurrentTrial: boolean;
  aiRationale: string;
  trialDesign: TrialDesignInputs;
  enrollmentRatePerMonth: number;
  treatmentObsMonths: number;
  startupCushionMonths: number;
  enrollmentComplete?: boolean;
  completionDate?: string;
  nullResponseRate?: number;
  expectedResponseRate?: number;
  expectedResponseRateBasis?: string;
  isTimeToEvent?: boolean;
  endpointRationale?: string;
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED";
  comparatorSigma2?: number;
  comparatorSource?: string;
  // Base re-pin (G3): registration-endpoint reg-acceptance observables (resolve-or-flag).
  fdaGuidanceForEndpoint?: boolean;
  priorFullApprovalsOnEndpoint?: "none" | "one_or_two" | "many";
  acceleratedOnlyPrecedent?: boolean;
  approvedInClassOnEndpoint?: boolean;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const {
    drug, indication, phase, mechanism, sponsor,
    currentTrialDesign, currentTrialName, currentTrialEnrollmentComplete, currentTrialCompletionDate,
  } = req.body as RequestBody;

  if (!drug || !currentTrialDesign) {
    return res.status(400).json({ error: "drug and currentTrialDesign required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const VALID_ENDPOINT: EndpointType[]         = ["hard", "surrogate", "pro"];
  const VALID_DESIGN: DesignType[]             = ["rct", "single_arm", "basket"];
  const VALID_POP: PopulationType[]            = ["biomarker_selected", "broad", "rare_small"];
  const VALID_PLACEBO: PlaceboResponse[]       = ["low", "moderate", "high"];
  const VALID_REG: RegulatoryContext[]         = ["standard", "fast_track", "btd", "orphan", "btd_orphan", "accelerated", "confirmatory"];

  const currentDesignSummary = [
    `n=${currentTrialDesign.n}`,
    currentTrialDesign.designType.replace("_", " "),
    currentTrialDesign.endpointType + " endpoint",
    currentTrialDesign.regulatoryContext,
    currentTrialDesign.endpointDescription ? `(${currentTrialDesign.endpointDescription})` : "",
  ].filter(Boolean).join(" · ");

  const systemPrompt = `You are a clinical development expert planning the development path for a pharma drug asset.

Your task: given the current clinical trial (already running), reason about what trials must happen NEXT to get this drug to regulatory approval. Return a JSON array of ALL stages in the development path, including the current trial.

${CPP_REFERENCE}

${DURATION_REFERENCE}

RULES:
1. Include the CURRENT TRIAL as stage 1 (isCurrentTrial: true) with the design parameters I provide — do NOT change them. The stage 1 "phase" field MUST equal the Current Phase I pass in (e.g. if Current Phase = "Phase 2", stage 1 phase = "Phase 2").
2. Add exactly 1 FUTURE clinical trial stage (isCurrentTrial: false) — the registration/pivotal study. That is all.
3. CRITICAL: The "stages" array must contain ONLY clinical trials. Do NOT include regulatory submission, BLA filing, NDA preparation, label negotiation, or any FDA/EMA review activity as a stage. Regulatory activities are handled separately outside this array.
4. Typical paths (always exactly 2 stages total):
   - Phase 2 single-arm → Phase 3 RCT registration study
   - Phase 2 RCT → Phase 3 larger confirmatory RCT
   - Phase 3 already running → only 1 stage (the current trial); no future stages needed
5. For rare/orphan drugs: registration study may need only n=50–150 if strong Phase 2 data
6. For common indications: Phase 3 typically n=200–500+
7. CPP: estimate realistically based on disease area, delivery route, endpoint complexity
8. Trial design for the registration study: generally RCT where single-arm Phase 2 preceded it
9. For EACH stage, also estimate enrollmentRatePerMonth, treatmentObsMonths, and startupCushionMonths using the TRIAL DURATION BENCHMARKS above — reason about the specific indication, endpoint, and site availability the same way you reason about CPP

REGULATORY CONTEXT — reason from what you know:
- The regulatoryContext for the future stage should be the same or upgraded vs current (e.g. if Phase 2 has orphan, Phase 3 also has orphan; if BTD granted, keep btd_orphan)
- This field goes in the trialDesign block — it lowers the evidentiary threshold for that trial's success probability calculation

NULL RESPONSE RATE — REQUIRED for each stage:
10. For EACH stage, estimate "nullResponseRate": the standard-of-care or historical control response rate for this indication and endpoint. Express as a decimal (0-1). This is the response rate the drug must BEAT to demonstrate efficacy.
   - Oncology solid tumors with no effective SOC: 0.03–0.10
   - Hematology with existing SOC: 0.15–0.30
   - Inherited diseases with no treatment: 0.02–0.05
   - Common disease with strong SOC: 0.25–0.50
   Think: "what response rate would a placebo or SOC patient show for this endpoint?"

11. ENDPOINT TYPE — CRITICAL, read carefully before setting isTimeToEvent:
   Set "isTimeToEvent": true ONLY if the PRIMARY gating endpoint is OS, PFS, DFS, RFS, EFS,
   or any Kaplan-Meier / time-to-event / survival endpoint. These are measured in time units.
   Set "isTimeToEvent": false for ALL of the following (they are RATES, not time-to-event):
   - ORR, DCR, CR rate, PR rate (oncology response rates)
   - ctDNA clearance, ctDNA negativity (proportion of patients clearing ctDNA)
   - MRD negativity rate, MRD clearance rate
   - Biomarker clearance rate (any % of patients achieving a clearance/negativity endpoint)
   - BCVA improvement, visual acuity endpoints (measured at a fixed time point)
   - Pathological complete response (pCR)
   - Any endpoint measuring a PROPORTION of patients achieving a binary outcome
   When a stage has BOTH a rate endpoint (e.g. ctDNA clearance as primary gate) AND a
   time-to-event secondary (e.g. RFS), isTimeToEvent reflects the PRIMARY GATING endpoint ONLY.

12. ENDPOINT RATIONALE — REQUIRED for EACH stage:
   Set "endpointRationale": a plain-language sentence explaining WHY this endpoint is the
   right primary readout for this stage.
   - Current trial: explain why this endpoint is the proof-of-concept or gating readout
     for this specific stage (e.g. "ctDNA clearance is the proof-of-concept readout for
     this Phase 2a because in the MRD setting there is no measurable disease for RECIST,
     and ctDNA clearance is the validated early signal of MRD elimination").
   - Future/pivotal stage: explain why this endpoint is the expected registration basis.

13. ENDPOINT EVIDENCE BASIS — REQUIRED for EACH stage:
   Set "endpointEvidenceBasis": "CONFIRMED" if the company has publicly stated this endpoint
   (e.g. CT.gov primary endpoint, investor presentation, press release). "INFERRED" if you
   are inferring it from FDA precedent, regulatory convention, or clinical practice — e.g.
   "Phase 3 modeled on RFS — FDA precedent in adjuvant/MRD settings; not stated by company."
   NEVER present a convention-based inference as CONFIRMED.

EXPECTED RESPONSE RATE — set when SOURCED, omit when not:
13b. For each stage, IF the drug has its OWN observed data on this stage's endpoint (a completed or
   read-out trial) OR a directly comparable NAMED analog reported a rate on the same endpoint in the
   same setting, set "expectedResponseRate": the sourced expected response rate for the DRUG (0-1
   decimal), and "expectedResponseRateBasis": one sentence naming the source (trial + figure, or the
   analog + figure). The engine uses this to scale the effect prior's margin — a drug with an observed
   64% clearance vs a 15% null carries a far larger expected margin than an unsourced default.
   WITHOUT a named basis the number is IGNORED and flagged, so an uncited estimate is wasted effort.
   OMIT both fields entirely when no sourced figure exists — do NOT guess one from the mechanism.
   This is the DRUG's expected rate; nullResponseRate remains the comparator's.
   UNIT RULE (hard): expectedResponseRate must be a PROPORTION OF PATIENTS — the fraction of treated
   patients meeting a defined responder criterion (e.g. "52% of patients achieved ORR", "48% met the
   MCID responder definition"). It is NEVER a percent change, percent improvement, percent slowing,
   or relative reduction of a continuous measure. "67% slowing of FVC decline", "+3.95% FVC vs
   placebo", "40% reduction in decline rate" are effect sizes, NOT response rates — emitting one of
   those here corrupts the probability engine with a unit error. For continuous endpoints (FVC, mL,
   points, mm Hg), only emit a rate if the source explicitly reports a RESPONDER ANALYSIS (% of
   patients above/below a defined cutoff) — otherwise OMIT. The basis sentence must contain the
   words "of patients" describing the sourced figure, or the value will be ignored.

INDICATION REPLICATION RISK — the graveyard check (top-level field, not per-stage):
13c. Set "replicationRisk": { "pFail": 0-1, "basis": "..." } = the probability that a positive
   early/mid-phase efficacy signal in THIS INDICATION fails to reproduce in later confirmatory
   trials, grounded ONLY in the indication's NAMED replication record: list the programs whose
   positive Phase 2 (or 2a/2b) efficacy readouts went on to confirmatory trials, and tally how many
   replicated vs failed. Example (IPF): nintedanib replicated (TOMORROW→INPULSIS); pamrevlumab
   (PRAISE→ZEPHYRUS), zinpentraxin (PRM-151), ziritaxestat (ISABELA), interferon-γ (INSPIRE) failed —
   pFail ≈ 0.55-0.7. The basis MUST name the programs and give the tally; an uncited pFail is
   ignored. Do NOT count mechanism-class effect evidence (that lives in the effect prior) or generic
   industry base rates — this is the INDICATION's own Phase 2→3 signal-durability history,
   mechanism-agnostic. If fewer than 3 named precedents exist for the indication, OMIT the field
   entirely. Range 0.05-0.8. This drives a real probability component — a lazy default here corrupts
   the valuation; a well-researched one is among the most valuable numbers in the plan.

14. COMPARATOR UNCERTAINTY — REQUIRED for each stage:
   Set "comparatorSigma2": the variance of the historical control / SOC response rate estimate.
   This reflects how well-established the comparator rate is, NOT the drug's uncertainty.
   - RCT (concurrent control arm measured in-trial): 0.000 — the control is measured directly
   - Single-arm vs well-studied SOC (large meta-analysis, 200+ patients, multiple publications):
     0.002–0.006 (narrow — we know the rate well)
   - Single-arm vs single reference study (n=50-100): 0.008–0.015
   - Single-arm vs approximate/informal historical control: 0.015–0.035
   - Single-arm vs sparse/preliminary data (1-2 small studies, heterogeneous): 0.025–0.050
   Set "comparatorSource": one sentence describing where the comparator rate comes from
   (e.g. "ORR 5% from pooled analysis of BSC in 3L+ CRC, Smith et al. JCO 2023").
   This is DIFFERENT from nullResponseRate (which is the mean) — comparatorSigma2 is
   the UNCERTAINTY AROUND that mean, reflecting how well we know it.

15. CONTINUOUS ENDPOINT STATS — ONLY for a CONTINUOUS primary endpoint (a measured value
   on a scale: FVC/FEV1 decline in mL, BCVA letters, 6MWD metres, HbA1c %, PASI/ADAS-Cog
   score, eGFR). Inside "trialDesign", set BOTH:
     - "outcomeSd": the outcome's standard deviation on its NATIVE scale, from analog trials
       (e.g. FVC-decline SD ≈ 200 mL from IPF trials; BCVA-change SD ≈ 12 letters).
     - "mdeOrExpectedDelta": the expected treatment effect Δ on the SAME native scale
       (e.g. 100 mL FVC benefit; 8 BCVA letters) — the effect this drug is expected to show,
       consistent with the efficacy prior.
   These let the engine compute the endpoint's REAL two-sample power instead of a response-
   rate proxy. RESOLVE both from analog-trial SDs / SAP / precedent, or OMIT them and note in
   endpointRationale that they were unconfirmable — the engine then FLAGS and falls back to
   the proportion path. NEVER invent a default SD (a fabricated SD would distort power).
   OMIT both entirely for RATE/PROPORTION endpoints (ORR, CR, ctDNA/MRD clearance, pCR) and
   for time-to-event endpoints (OS/PFS/RFS — handled separately) — do NOT set them there.

16. REGULATORY-ENDPOINT ACCEPTABILITY — on the REGISTRATION (final) stage, resolve how likely
   FDA is to ACCEPT its endpoint as an approval basis, from OBSERVABLES (searched-or-FLAG,
   never guessed). A hard clinical-outcome endpoint (OS, CR, organ function) needs nothing —
   the engine treats it as the top level. For a SURROGATE/PRO registration endpoint set what
   you can source: "fdaGuidanceForEndpoint" (does FDA guidance endorse it?),
   "priorFullApprovalsOnEndpoint" ("none"/"one_or_two"/"many" FULL — non-accelerated — approvals
   on THIS endpoint), "acceleratedOnlyPrecedent" (approvals exist only via accelerated approval),
   "approvedInClassOnEndpoint". If you CANNOT confirm any of these, leave them unset — the
   engine HOLDS the reg gate at the designation base rate and FLAGS it (it does NOT penalize).
   Only set priorFullApprovalsOnEndpoint:"none" when you POSITIVELY establish no precedent
   exists. Do NOT fabricate guidance or approval counts.

17. BIOMARKER PREVALENCE — when a stage's trialDesign.populationType is "biomarker_selected",
   set trialDesign.biomarkerPrevalence (the responder fraction, 0–1) when you can source it —
   it sizes the effect-concentration lift the engine applies to that stage. If genuinely
   unavailable, leave it unset (the engine uses a grounded default and flags it). Never invent
   a prevalence.

ABSOLUTE CONSTRAINT: Return EXACTLY 2 stages if currently in Phase 2, or EXACTLY 1 stage if currently in Phase 3. Never return 3 or more stages.

RESPONSE FORMAT — return ONLY this JSON, no markdown:
{
  "stages": [
    {
      "id": "stage-1",
      "name": "Name of this trial (e.g. ABACUS-2 Phase 2)",
      "phase": "Phase 2",
      "n": 40,
      "cpp": 200000,
      "enrollmentRatePerMonth": 2,
      "treatmentObsMonths": 12,
      "startupCushionMonths": 8,
      "nullResponseRate": 0.05,
      "isTimeToEvent": false,
      "endpointRationale": "BCVA and light sensitivity are the primary functional readouts; BCVA is the FDA-accepted endpoint for retinal dystrophy (LUXTURNA precedent).",
      "endpointEvidenceBasis": "CONFIRMED",
      "comparatorSigma2": 0.012,
      "comparatorSource": "Natural history data: ~5% spontaneous BCVA improvement in IRD, from 3 retrospective studies.",
      "isCurrentTrial": true,
      "aiRationale": "One sentence explaining this stage.",
      "trialDesign": {
        "n": 40,
        "endpointType": "surrogate",
        "designType": "single_arm",
        "populationType": "rare_small",
        "placeboResponse": "low",
        "regulatoryContext": "orphan",
        "endpointDescription": "BCVA and light sensitivity testing",
        "enrollmentNote": "n=40, single-arm open-label, rare inherited retinal disease"
      }
    },
    {
      "id": "stage-2",
      "name": "Name of next trial (e.g. KIO-301 Registration Study)",
      "phase": "Phase 3",
      "n": 150,
      "cpp": 320000,
      "enrollmentRatePerMonth": 3,
      "treatmentObsMonths": 12,
      "startupCushionMonths": 8,
      "nullResponseRate": 0.05,
      "isTimeToEvent": false,
      "endpointRationale": "BCVA improvement vs sham control is the registration endpoint — inferred from FDA precedent in inherited retinal disease (LUXTURNA, Spark Therapeutics).",
      "endpointEvidenceBasis": "INFERRED",
      "comparatorSigma2": 0.000,
      "comparatorSource": "Sham injection arm measured in-trial (concurrent control).",
      "isCurrentTrial": false,
      "aiRationale": "One sentence explaining why this stage is needed.",
      "trialDesign": {
        "n": 150,
        "endpointType": "surrogate",
        "designType": "rct",
        "populationType": "rare_small",
        "placeboResponse": "low",
        "regulatoryContext": "btd_orphan",
        "endpointDescription": "BCVA improvement at 12 months vs sham control",
        "enrollmentNote": "n=150, randomized 2:1 vs sham injection"
      }
    }
  ],
  "regulatoryContext": "btd_orphan",
  "reasoning": "2-3 sentence explanation of the development path rationale.",
  "replicationRisk": {
    "pFail": 0.55,
    "basis": "IPF Phase 2→3 replication record: nintedanib (TOMORROW→INPULSIS) replicated; pamrevlumab (PRAISE→ZEPHYRUS-1/2), zinpentraxin/PRM-151, ziritaxestat (ISABELA), and interferon-γ (INSPIRE) all failed confirmatory trials after positive earlier signals — ~1-2 of 6-7 named attempts replicated."
  }
}`;

  const userMessage = `Drug: ${drug}
Indication: ${indication || "unknown"}
Current Phase: ${phase}${mechanism ? `\nMechanism: ${mechanism}` : ""}${sponsor ? `\nSponsor: ${sponsor}` : ""}
MODALITY FIDELITY: describe the drug using its ACTUAL modality from the mechanism above. Do NOT mislabel it (e.g. an antisense / anti-miR oligonucleotide is NOT an "mRNA immunotherapy"; an antibody is not a small molecule). Any modality reference in your reasoning must match the stated mechanism.

Current Trial${currentTrialName ? ` (${currentTrialName})` : ""}:
${currentDesignSummary}

Reason about the full development path. Return the current trial as stage 1 (use the design parameters above exactly), then add the future stages needed for approval.`;

  const __t0 = logStart("dev-plan");
  try {
    const raw = await callClaudeWithSearch({
      anthropicKey: apiKey,
      model: "claude-haiku-4-5-20251001",
      system: systemPrompt,
      userMessage,
      // 1200 was too tight for two fully-populated stages (~15 fields each,
      // several full sentences) — the JSON truncated mid-object and parse threw.
      maxTokens: 3000,
      maxSearches: 0,
      serperQueries: [
        `${drug} phase 3 registration study design ${indication}`,
        `${drug} clinical development plan FDA approval pathway`,
      ],
    });

    // Robust parse: tolerate code fences, surrounding prose, and trailing commas.
    const { value: parsed, error: parseErr, candidate } = parseJsonLoose<any>(raw);
    if (!parsed) {
      console.error(
        `[dev-plan] malformed JSON — ${parseErr} | rawLen=${raw.length} ` +
        `head=${JSON.stringify(candidate.slice(0, 500))}`,
      );
      throw new Error(`Model did not return valid development-plan JSON (${parseErr}).`);
    }

    // Validate and clean each stage
    const stages: StageOutput[] = (parsed.stages ?? []).map((s: any, i: number) => {
      const td: TrialDesignInputs = {
        n:                  (typeof s.trialDesign?.n === "number" && s.trialDesign.n > 0) ? Math.round(s.trialDesign.n) : 60,
        endpointType:       VALID_ENDPOINT.includes(s.trialDesign?.endpointType) ? s.trialDesign.endpointType : "surrogate",
        designType:         VALID_DESIGN.includes(s.trialDesign?.designType) ? s.trialDesign.designType : "rct",
        populationType:     VALID_POP.includes(s.trialDesign?.populationType) ? s.trialDesign.populationType : "broad",
        placeboResponse:    VALID_PLACEBO.includes(s.trialDesign?.placeboResponse) ? s.trialDesign.placeboResponse : "low",
        regulatoryContext:  VALID_REG.includes(s.trialDesign?.regulatoryContext) ? s.trialDesign.regulatoryContext : "standard",
        endpointDescription: s.trialDesign?.endpointDescription || "",
        enrollmentNote:     s.trialDesign?.enrollmentNote || "",
        // G2 Phase 2a: continuous native-scale stats — kept ONLY when both are valid positives
        // (resolve-or-flag; absent → engine uses the proportion path). Never defaulted.
        ...(typeof s.trialDesign?.outcomeSd === "number" && s.trialDesign.outcomeSd > 0
          ? { outcomeSd: s.trialDesign.outcomeSd } : {}),
        ...(typeof s.trialDesign?.mdeOrExpectedDelta === "number" && s.trialDesign.mdeOrExpectedDelta > 0
          ? { mdeOrExpectedDelta: s.trialDesign.mdeOrExpectedDelta } : {}),
        // Base re-pin: biomarker enrichment lift signal. When populationType is
        // biomarker_selected, computeDevPlan enriches THIS stage's prior per-stage; a sourced
        // responder prevalence sizes the lift (else DEFAULT + flag). Resolve-or-flag: emit
        // biomarkerPrevalence when known; never fabricate one.
        ...(typeof s.trialDesign?.biomarkerPrevalence === "number" && s.trialDesign.biomarkerPrevalence > 0 && s.trialDesign.biomarkerPrevalence <= 1
          ? { biomarkerPrevalence: s.trialDesign.biomarkerPrevalence } : {}),
      };

      // Stage 1 (current trial) — lock design to what was passed in
      if (i === 0) {
        Object.assign(td, {
          ...currentTrialDesign,
          n: s.n || currentTrialDesign.n,
        });
      }

      return {
        id:             s.id || `stage-${i + 1}`,
        name:           s.name || `Stage ${i + 1}`,
        phase:          i === 0 ? phase : (s.phase || "Phase 3"),
        n:              (typeof s.n === "number" && s.n > 0) ? Math.round(s.n) : td.n,
        cpp:            (typeof s.cpp === "number" && s.cpp > 0) ? Math.round(s.cpp) : 200000,
        enrollmentRatePerMonth: (typeof s.enrollmentRatePerMonth === "number" && s.enrollmentRatePerMonth > 0) ? s.enrollmentRatePerMonth : 5,
        treatmentObsMonths:     (typeof s.treatmentObsMonths === "number" && s.treatmentObsMonths > 0) ? s.treatmentObsMonths : 9,
        startupCushionMonths:   (typeof s.startupCushionMonths === "number" && s.startupCushionMonths >= 0) ? s.startupCushionMonths : 6,
        // Only the current trial (stage 0) can be "already enrolled" — future stages
        // always carry projected accrual. Drives the 0-remaining-enrollment rule.
        enrollmentComplete: i === 0 ? currentTrialEnrollmentComplete === true : false,
        completionDate: i === 0 ? (currentTrialCompletionDate || undefined) : undefined,
        isCurrentTrial: i === 0,
        aiRationale:    s.aiRationale || "",
        trialDesign:    td,
        // Bayesian RR engine inputs
        nullResponseRate: (typeof s.nullResponseRate === "number" && s.nullResponseRate > 0 && s.nullResponseRate < 1)
          ? Math.round(s.nullResponseRate * 1000) / 1000  // clamp to 3 decimal places
          : undefined,  // let dev-plan.ts use DEFAULT_NULL_RR
        // Sourced expected rate (13b) — sets the stage's margin scale (Δ_stage). Passed through only
        // as a valid decimal; the citation gate (basis required, else ignored + flagged) is enforced
        // deterministically in lib/dev-plan.ts, not here.
        expectedResponseRate: (typeof s.expectedResponseRate === "number" && s.expectedResponseRate > 0 && s.expectedResponseRate < 1)
          ? Math.round(s.expectedResponseRate * 1000) / 1000
          : undefined,
        expectedResponseRateBasis: typeof s.expectedResponseRateBasis === "string" && s.expectedResponseRateBasis.trim()
          ? s.expectedResponseRateBasis.trim()
          : undefined,
        isTimeToEvent: s.isTimeToEvent === true,
        endpointRationale: typeof s.endpointRationale === "string" ? s.endpointRationale : undefined,
        endpointEvidenceBasis: (s.endpointEvidenceBasis === "CONFIRMED" || s.endpointEvidenceBasis === "INFERRED")
          ? s.endpointEvidenceBasis : "INFERRED",
        comparatorSigma2: (typeof s.comparatorSigma2 === "number" && s.comparatorSigma2 >= 0 && s.comparatorSigma2 < 0.5)
          ? Math.round(s.comparatorSigma2 * 10000) / 10000  // 4 decimal places
          : 0,
        comparatorSource: typeof s.comparatorSource === "string" ? s.comparatorSource : undefined,
        // Base re-pin (G3): registration-endpoint reg-acceptance observables (resolve-or-FLAG).
        // Kept only when the generator resolves them; absent → the engine HOLDS the reg gate at
        // the designation base rate and FLAGS (never auto-penalized). See RULE 16.
        fdaGuidanceForEndpoint: typeof s.fdaGuidanceForEndpoint === "boolean" ? s.fdaGuidanceForEndpoint : undefined,
        priorFullApprovalsOnEndpoint: (s.priorFullApprovalsOnEndpoint === "none" || s.priorFullApprovalsOnEndpoint === "one_or_two" || s.priorFullApprovalsOnEndpoint === "many")
          ? s.priorFullApprovalsOnEndpoint : undefined,
        acceleratedOnlyPrecedent: typeof s.acceleratedOnlyPrecedent === "boolean" ? s.acceleratedOnlyPrecedent : undefined,
        approvedInClassOnEndpoint: typeof s.approvedInClassOnEndpoint === "boolean" ? s.approvedInClassOnEndpoint : undefined,
      };
    });

    // Hard cap: Phase 2 → max 2 stages, Phase 3 → max 1 stage.
    // Prevents Claude hallucinating regulatory activities as clinical trials.
    const maxStages = (phase || "").includes("3") ? 1 : 2;
    const cappedStages = stages.slice(0, maxStages);

    // ── Pin literature/precedent inputs (deterministic, per-indication) ───────
    // Overrides the LLM's per-run guesses for the two inputs that were swinging
    // the waterfall: the Phase-3 registrable endpoint and the Phase-2a comparator.
    for (const st of cappedStages) {
      // (1) Phase-3 endpoint: pin to the FDA-registrable endpoint from precedent
      //     (e.g. DFS/RFS for MRD+ adjuvant CRC). Apply FIRST — it can flip a
      //     stage to time-to-event, which then excludes it from the rate comparator.
      if (!st.isCurrentTrial) {
        const epPin = pinPhase3Endpoint(indication || "", st.phase);
        if (epPin) {
          st.isTimeToEvent = epPin.isTimeToEvent;
          st.endpointRationale = epPin.endpointRationale;
          st.endpointEvidenceBasis = "INFERRED"; // precedent-based, not company-stated
          st.trialDesign.endpointDescription = epPin.endpointDescription;
        }
      }
      // (2) Comparator: pin the historical-control RATE (ctDNA clearance) + honest σ²
      //     for rate-endpoint stages only.
      const cmpPin = pinComparator(indication || "", st.isTimeToEvent !== true);
      if (cmpPin) {
        st.nullResponseRate = cmpPin.nullResponseRate;
        st.comparatorSigma2 = cmpPin.comparatorSigma2;
        st.comparatorSource = cmpPin.source;
      }
    }

    // ── Pin the regulatory context deterministically (Part 1) ────────────────
    // A drug's FDA designations are FACTS; they must not flip run-to-run (tau swung
    // btd↔standard, applying a bar-ease it never earned — it has Fast Track, not
    // BTD). Resolve from the factual designation registry (regulatory-pins.ts);
    // an unconfirmed asset defaults to "standard" (no unearned benefit). This
    // OVERRIDES the LLM's per-run guess. Applied to the top level AND every stage
    // (each stage's trialDesign.regulatoryContext drives the per-stage Z_ALPHA bar).
    const regPin = resolveRegulatoryContext({ asset: drug });
    const regulatoryContext: RegulatoryContext = regPin.context;
    for (const st of cappedStages) {
      if (st.trialDesign) st.trialDesign.regulatoryContext = regulatoryContext;
    }

    // Replication risk (13c) — validated pass-through only; the citation gate + band clamp live
    // deterministically in lib/dev-plan.ts. Malformed → omitted (no claim, no component).
    const rrRaw = parsed.replicationRisk;
    const replicationRisk =
      rrRaw && typeof rrRaw.pFail === "number" && Number.isFinite(rrRaw.pFail) &&
      rrRaw.pFail > 0 && rrRaw.pFail < 1 &&
      typeof rrRaw.basis === "string" && rrRaw.basis.trim()
        ? { pFail: Math.round(rrRaw.pFail * 1000) / 1000, basis: rrRaw.basis.trim() }
        : undefined;

    logEnd("dev-plan", __t0, "ok", { stages: cappedStages.length, replicationRisk: replicationRisk?.pFail ?? null });
    return res.status(200).json({
      stages: cappedStages,
      regulatoryContext,
      regulatoryProvenance: regPin.provenance,
      regulatoryDesignations: regPin.designations,
      reasoning: parsed.reasoning || "",
      ...(replicationRisk ? { replicationRisk } : {}),
    });

  } catch (e: any) {
    const msg = e?.message ?? "Dev plan generation failed";
    logEnd("dev-plan", __t0, "error", { msg });
    console.error("[dev-plan] Failed:", msg);
    if (msg.toLowerCase().includes("credit balance")) {
      return res.status(402).json({ error: "API credits are out — top up at console.anthropic.com." });
    }
    return res.status(500).json({ error: msg });
  }
}
