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
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const {
    drug, indication, phase, mechanism, sponsor,
    currentTrialDesign, currentTrialName,
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
  const VALID_REG: RegulatoryContext[]         = ["standard", "btd", "orphan", "btd_orphan", "accelerated", "confirmatory"];

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
  "reasoning": "2-3 sentence explanation of the development path rationale."
}`;

  const userMessage = `Drug: ${drug}
Indication: ${indication || "unknown"}
Current Phase: ${phase}${mechanism ? `\nMechanism: ${mechanism}` : ""}${sponsor ? `\nSponsor: ${sponsor}` : ""}

Current Trial${currentTrialName ? ` (${currentTrialName})` : ""}:
${currentDesignSummary}

Reason about the full development path. Return the current trial as stage 1 (use the design parameters above exactly), then add the future stages needed for approval.`;

  try {
    const raw = await callClaudeWithSearch({
      anthropicKey: apiKey,
      model: "claude-haiku-4-5-20251001",
      system: systemPrompt,
      userMessage,
      maxTokens: 1200,
      maxSearches: 0,
      serperQueries: [
        `${drug} phase 3 registration study design ${indication}`,
        `${drug} clinical development plan FDA approval pathway`,
      ],
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");
    const parsed = JSON.parse(jsonMatch[0]);

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
        isCurrentTrial: i === 0,
        aiRationale:    s.aiRationale || "",
        trialDesign:    td,
      };
    });

    // Hard cap: Phase 2 → max 2 stages, Phase 3 → max 1 stage.
    // Prevents Claude hallucinating regulatory activities as clinical trials.
    const maxStages = (phase || "").includes("3") ? 1 : 2;
    const cappedStages = stages.slice(0, maxStages);

    const regulatoryContext: RegulatoryContext = VALID_REG.includes(parsed.regulatoryContext)
      ? parsed.regulatoryContext
      : (currentTrialDesign.regulatoryContext ?? "standard");

    return res.status(200).json({
      stages: cappedStages,
      regulatoryContext,
      reasoning: parsed.reasoning || "",
    });

  } catch (e: any) {
    console.error("[dev-plan] Failed:", e?.message);
    return res.status(500).json({ error: e?.message ?? "Dev plan generation failed" });
  }
}
