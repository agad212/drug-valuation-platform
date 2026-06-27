// ═══════════════════════════════════════════════════════════════════════════
// Lead Reasoner — Strategic Assessment Endpoint
// ═══════════════════════════════════════════════════════════════════════════
//
// POST /api/lead-reasoner
//
// Runs FIRST in the valuation pipeline. Uses the strongest available model
// with web search to INVESTIGATE a drug asset and produce a structured
// valuationBrief that GOVERNS all downstream modules.
//
// This is where JUDGMENT lives — distinguishing efficacy trials from
// substudies, inferring company strategy from public signals, anchoring
// thresholds to real SOC data. Downstream modules execute under its
// framing; they do not run independent selection.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { NextApiRequest, NextApiResponse } from "next";
import type { ValuationBrief } from "../../lib/valuation-brief";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const { drug, sponsor, phase, mechanism, indication } = req.body as {
    drug: string;
    sponsor?: string;
    phase?: string;
    mechanism?: string;
    indication?: string;
  };

  if (!drug?.trim()) {
    return res.status(400).json({ error: "drug name is required" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const systemPrompt = buildSystemPrompt();

  const userMessage = buildUserMessage(drug, sponsor, phase, mechanism, indication);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!r.ok) {
      const errJson = await r.json().catch(() => ({})) as any;
      const errMsg = errJson?.error?.message ?? "";
      if (errMsg.toLowerCase().includes("credit balance")) {
        return res.status(402).json({ error: "API credits are out — top up at console.anthropic.com." });
      }
      return res.status(r.status).json({ error: `API error: ${errMsg || r.status}` });
    }

    const data = await r.json() as any;

    // Extract text blocks from the response (skip web_search_tool_result blocks)
    const rawText: string = (data.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

    // Parse the structured valuationBrief from <valuation_brief> tags
    const briefMatch = rawText.match(/<valuation_brief>([\s\S]*?)<\/valuation_brief>/);
    if (!briefMatch) {
      return res.status(200).json({
        brief: null,
        summary: sanitize(rawText),
        error: "Lead reasoner did not produce a structured brief. Re-running may help.",
      });
    }

    let brief: ValuationBrief;
    try {
      brief = JSON.parse(briefMatch[1].trim());
    } catch {
      return res.status(200).json({
        brief: null,
        summary: sanitize(rawText),
        error: "Lead reasoner produced malformed brief JSON.",
      });
    }

    // Validate critical fields
    brief = validateBrief(brief, drug, sponsor);

    // Extract the human-readable summary (everything outside the JSON block)
    const summary = sanitize(
      rawText.replace(/<valuation_brief>[\s\S]*?<\/valuation_brief>/g, ""),
    );

    return res.status(200).json({ brief, summary });

  } catch (e: any) {
    console.error("[lead-reasoner] Failed:", e?.message);
    return res.status(500).json({ error: e?.message ?? "Lead reasoner failed" });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sanitize(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, "")
    .replace(/<thinking>[\s\S]*/gi, "")
    .trim();
}

function validateBrief(brief: any, drug: string, sponsor?: string): ValuationBrief {
  const VALID_CONF = ["CONFIRMED", "STRONG_INFERENCE", "WEAK_INFERENCE", "SPECULATIVE"];
  const clampConf = (c: any) => VALID_CONF.includes(c) ? c : "WEAK_INFERENCE";

  const tagged = (v: any, fallback: any) => {
    if (v && typeof v === "object" && "value" in v) {
      return { value: v.value ?? fallback, confidence: clampConf(v.confidence), source: v.source ?? "" };
    }
    return { value: v ?? fallback, confidence: "WEAK_INFERENCE" as const, source: "" };
  };

  const socRate = brief.soc_response_rate ?? {};
  const anchor = brief.expectation_anchor ?? {};

  // Check if base case rests on thin evidence
  const baseConfidences = [
    brief.base_case_indication?.confidence,
    brief.base_case_endpoint?.confidence,
    brief.soc_response_rate?.confidence,
  ].map(clampConf);
  const isLowConf = baseConfidences.some(
    (c: string) => c === "WEAK_INFERENCE" || c === "SPECULATIVE"
  );

  return {
    drug: brief.drug ?? drug,
    sponsor: brief.sponsor ?? sponsor ?? "",
    true_stage: tagged(brief.true_stage, "Phase 2"),
    efficacy_gate_trial: {
      trial_id:       brief.efficacy_gate_trial?.trial_id ?? "",
      trial_name:     brief.efficacy_gate_trial?.trial_name ?? "",
      is_efficacy_gate: brief.efficacy_gate_trial?.is_efficacy_gate !== false,
      reason:         brief.efficacy_gate_trial?.reason ?? "",
      confidence:     clampConf(brief.efficacy_gate_trial?.confidence),
    },
    excluded_trials: Array.isArray(brief.excluded_trials)
      ? brief.excluded_trials.map((t: any) => ({
          trial_id: t.trial_id ?? "",
          trial_name: t.trial_name,
          reason_excluded: t.reason_excluded ?? "excluded by lead reasoner",
        }))
      : [],
    base_case_indication: tagged(brief.base_case_indication, ""),
    base_case_endpoint:   tagged(brief.base_case_endpoint, ""),
    comparator:           tagged(brief.comparator, ""),
    soc_response_rate: {
      value:      typeof socRate.value === "number" ? Math.max(0.01, Math.min(0.95, socRate.value)) : 0.15,
      source:     socRate.source ?? "",
      confidence: clampConf(socRate.confidence),
    },
    development_sequence: tagged(brief.development_sequence, []),
    designation_assumptions: tagged(brief.designation_assumptions, ""),
    confirmed_strategy:  Array.isArray(brief.confirmed_strategy) ? brief.confirmed_strategy : [],
    inferred_strategy:   Array.isArray(brief.inferred_strategy) ? brief.inferred_strategy : [],
    expectation_anchor: {
      range_low:  typeof anchor.range_low === "number" ? anchor.range_low : 0.10,
      range_high: typeof anchor.range_high === "number" ? anchor.range_high : 0.30,
      reason:     anchor.reason ?? "",
    },
    key_risks:         Array.isArray(brief.key_risks) ? brief.key_risks : [],
    key_value_drivers: Array.isArray(brief.key_value_drivers) ? brief.key_value_drivers : [],
    is_low_confidence: isLowConf,
    low_confidence_reason: isLowConf
      ? "One or more base-case inputs rest on WEAK_INFERENCE or SPECULATIVE evidence."
      : undefined,
    sources_consulted: Array.isArray(brief.sources_consulted) ? brief.sources_consulted : [],
  };
}

// ─── Prompts ─────────────────────────────────────────────────────────────

function buildUserMessage(
  drug: string, sponsor?: string, phase?: string,
  mechanism?: string, indication?: string,
): string {
  const parts = [`Drug: ${drug}`];
  if (sponsor) parts.push(`Sponsor: ${sponsor}`);
  if (phase) parts.push(`Phase: ${phase}`);
  if (mechanism) parts.push(`Mechanism: ${mechanism}`);
  if (indication) parts.push(`Indication: ${indication}`);
  parts.push(
    "",
    "Investigate this drug asset and produce the structured valuationBrief.",
    "Use web search to find: ClinicalTrials.gov entries, investor presentations,",
    "earnings calls, press releases, conference abstracts, analyst commentary.",
    "Focus on JUDGMENT: what is this company actually trying to do, and what",
    "should we value?",
  );
  return parts.join("\n");
}

function buildSystemPrompt(): string {
  return `You are a senior pharmaceutical analyst and drug development strategist. Your job is to form a STRATEGIC ASSESSMENT of a drug asset — the kind of judgment a biotech BD executive would exercise — and emit it as a structured object that governs a downstream valuation engine.

You have web search available. USE IT to investigate the drug. Search for:
- ClinicalTrials.gov entries (identify ALL trials, distinguish efficacy studies from substudies)
- Investor presentations, earnings call transcripts, press releases (company's STATED strategy)
- Conference abstracts, KOL commentary (clinical community assessment)
- Analyst reports, partnership/licensing announcements (what partners are funding)

═══════════════════════════════════════════════════════
WHAT YOU MUST REASON ABOUT
═══════════════════════════════════════════════════════

1. TRUE STAGE / TRUE EFFICACY GATE
   NOT the ClinicalTrials.gov phase label — the ACTUAL trial that serves as the efficacy gate. Explicitly identify and EXCLUDE substudies that are NOT efficacy-defining:
   - PET/SPECT imaging studies (biodistribution, receptor occupancy)
   - PK/PD/ADME studies (pharmacokinetic characterization)
   - Dose-finding/DDI/food-effect studies
   - Biomarker/translational substudies
   - Healthy volunteer studies
   - Expanded access / compassionate use
   List each excluded trial with its ID and the reason it's excluded.

2. COMPANY'S ACTUAL DEVELOPMENT STRATEGY
   Synthesize the company's INTENT from public signals. What indication are they leading with? What's the pivotal path? What regulatory strategy (BTD, orphan, accelerated)?
   Separate CONFIRMED (company publicly stated) from INFERRED (deduced from signals).

3. RIGHT EFFICACY FRAME
   The pivotal indication, realistic endpoint, and the CLINICALLY MEANINGFUL RESPONSE RATE the trial must demonstrate to have a plausible path to approval.

   CRITICAL: soc_response_rate is NOT just the raw placebo/control rate — it is the MINIMUM response rate that would be considered clinically meaningful for registration in this indication.
   - If the raw SOC/control rate is very low (e.g., 2% spontaneous clearance, 5% BSC response), the soc_response_rate should STILL reflect what FDA/regulators would consider a meaningful clinical signal — typically 15-30%+ for oncology, depending on the setting and unmet need.
   - For time-to-event endpoints (OS, PFS, RFS, DFS) approximated via a response-rate proxy: set the threshold at 25-40% to reflect the genuine difficulty of demonstrating a survival benefit.
   - The soc_response_rate MUST be SOURCED — cite the study, regulatory guidance, or prescribing information. Do not guess.
   - Ask: "What response rate would convince an FDA reviewer that this drug works in this indication?" — THAT is the soc_response_rate.

4. EXPECTATION ANCHOR
   BEFORE any math runs, state your rough prior on the probability this drug gets approved. Express as a range (e.g., 15-30%) with reasoning. This is a SMOKE DETECTOR — it will be used to flag surprising math results for input audit, NEVER to adjust the output.

5. KEY RISKS / VALUE DRIVERS
   The 2-4 things that most determine whether this drug succeeds or fails.

═══════════════════════════════════════════════════════
CONFIDENCE TAGGING
═══════════════════════════════════════════════════════
Tag every strategy/frame field with one of:
  CONFIRMED — publicly stated, verifiable
  STRONG_INFERENCE — multiple converging public signals
  WEAK_INFERENCE — single signal or indirect evidence
  SPECULATIVE — educated guess with thin basis

Rules:
- Only CONFIRMED and STRONG_INFERENCE may GOVERN the base-case valuation
- WEAK_INFERENCE and SPECULATIVE may appear in commentary but must NOT drive the base case
- If the ONLY available basis for a critical field is WEAK_INFERENCE or SPECULATIVE, set is_low_confidence: true and explain why

═══════════════════════════════════════════════════════
REQUIRED OUTPUT FORMAT
═══════════════════════════════════════════════════════

You MUST emit a JSON object inside <valuation_brief> tags. This is not optional.
After the JSON block, write a plain-language summary of your assessment.

<valuation_brief>
{
  "drug": "drug name",
  "sponsor": "company name",
  "true_stage": { "value": "Phase 2", "confidence": "CONFIRMED", "source": "CT.gov NCT..." },
  "efficacy_gate_trial": {
    "trial_id": "NCT...",
    "trial_name": "Study name",
    "is_efficacy_gate": true,
    "reason": "Why this is the efficacy-defining study",
    "confidence": "CONFIRMED"
  },
  "excluded_trials": [
    { "trial_id": "NCT...", "trial_name": "PET imaging substudy", "reason_excluded": "Biodistribution/imaging study, not an efficacy endpoint" }
  ],
  "base_case_indication": { "value": "Indication name", "confidence": "STRONG_INFERENCE", "source": "Investor deck Q3 2025..." },
  "base_case_endpoint": { "value": "ORR by RECIST 1.1", "confidence": "CONFIRMED", "source": "CT.gov primary endpoint" },
  "comparator": { "value": "Physician's choice chemotherapy", "confidence": "STRONG_INFERENCE", "source": "Standard of care for this line" },
  "soc_response_rate": { "value": 0.12, "source": "Smith et al. JCO 2023, pooled ORR in 3L+ CRC", "confidence": "CONFIRMED" },
  "development_sequence": { "value": ["Phase 1b dose expansion", "Phase 2 single-arm", "Phase 3 randomized"], "confidence": "STRONG_INFERENCE", "source": "Investor presentation" },
  "designation_assumptions": { "value": "Fast Track granted; Orphan unlikely given prevalence", "confidence": "CONFIRMED", "source": "FDA press release" },
  "confirmed_strategy": ["Company stated CRC as lead indication in Q2 earnings call", "Phase 2 enrollment complete per PR"],
  "inferred_strategy": ["Likely to seek accelerated approval based on ORR given unmet need", "May expand to pancreatic based on basket cohort"],
  "expectation_anchor": { "range_low": 0.15, "range_high": 0.30, "reason": "First-in-class ASO in 3L CRC. Mechanism plausible but unvalidated class. Historical approval rate for novel-mechanism oncology Phase 2 assets ~20%." },
  "key_risks": ["Novel mechanism with no clinical precedent", "Single-arm design may not satisfy FDA for full approval"],
  "key_value_drivers": ["ORR in dose-expansion cohort (data expected Q4)", "Durability of response (>6 month follow-up)"],
  "is_low_confidence": false,
  "sources_consulted": ["ClinicalTrials.gov", "Company investor presentation Q3 2025", "Smith et al. JCO 2023"]
}
</valuation_brief>

[Your plain-language summary here — what is this company actually trying to do, and how should we think about it? Write for a biotech executive.]`;
}
