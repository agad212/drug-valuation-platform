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

RULES:
1. Include the CURRENT TRIAL as stage 1 (isCurrentTrial: true) with the design parameters I provide — do NOT change them.
2. Add 1–2 FUTURE stages (isCurrentTrial: false) needed to reach approval.
3. Typical paths:
   - Phase 2 single-arm orphan → Phase 3 RCT registration study → approval
   - Phase 2 RCT → Phase 3 confirmatory RCT (larger) → approval
   - Phase 3 already → just one more confirmatory if accelerated approval, else straight to approval
   - If already Phase 3: just one stage (the current trial), then reg
4. For rare/orphan drugs: registration study may need only n=50–150 if strong Phase 2 data
5. For common indications: Phase 3 typically n=200–500+
6. CPP: estimate realistically based on disease area, delivery route, endpoint complexity
7. Trial design for future stages: generally RCT where single-arm Phase 2 preceded it

REGULATORY CONTEXT — look this up or reason from what you know:
- The regulatoryContext for future stages should be the same or upgraded (e.g. if Phase 2 has orphan, Phase 3 likely also has orphan)
- If Phase 2 succeeded with BTD, Phase 3 may have accelerated approval option

RESPONSE FORMAT — return ONLY this JSON, no markdown:
{
  "stages": [
    {
      "id": "stage-1",
      "name": "Name of this trial (e.g. ABACUS-2 Phase 2)",
      "phase": "Phase 2",
      "n": 40,
      "cpp": 200000,
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
        phase:          s.phase || (i === 0 ? phase : "Phase 3"),
        n:              (typeof s.n === "number" && s.n > 0) ? Math.round(s.n) : td.n,
        cpp:            (typeof s.cpp === "number" && s.cpp > 0) ? Math.round(s.cpp) : 200000,
        isCurrentTrial: i === 0,
        aiRationale:    s.aiRationale || "",
        trialDesign:    td,
      };
    });

    const regulatoryContext: RegulatoryContext = VALID_REG.includes(parsed.regulatoryContext)
      ? parsed.regulatoryContext
      : (currentTrialDesign.regulatoryContext ?? "standard");

    return res.status(200).json({
      stages,
      regulatoryContext,
      reasoning: parsed.reasoning || "",
    });

  } catch (e: any) {
    console.error("[dev-plan] Failed:", e?.message);
    return res.status(500).json({ error: e?.message ?? "Dev plan generation failed" });
  }
}
