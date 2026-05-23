import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";

// ─── Claude revenue analysis with native web search ───────────────────────────

const SYSTEM_PROMPT = `You are a senior sell-side pharmaceutical analyst at a top-tier investment bank. You specialize in drug asset revenue modeling with 15+ years of experience covering biopharmaceuticals.

Use web_search to research each indication BEFORE estimating revenue. Search for:
- Analyst peak sales estimates (Goldman Sachs, Morgan Stanley, Jefferies, SVB, Leerink, etc.)
- Patient population / epidemiology data
- Comparable approved drugs and their peak sales
- Pricing benchmarks (WAC)
- Competitive landscape

## PRICING BENCHMARKS (WAC per patient per year, US market)
- PD-1/PD-L1 checkpoint inhibitors (oncology): $150,000–$200,000/yr
- ADC (antibody-drug conjugates): $200,000–$350,000/yr
- CAR-T / cell therapies: $400,000–$600,000 one-time
- Rare disease / orphan (<200K patients US): $300,000–$600,000/yr
- Common solid tumor oncology: $100,000–$180,000/yr
- Hematology (AML, MDS, multiple myeloma): $150,000–$300,000/yr
- Immunology / autoimmune (RA, IBD, psoriasis): $30,000–$80,000/yr
- Neurology / CNS: $20,000–$80,000/yr (rare CNS: $200,000–$500,000/yr)
- Alzheimer's disease (anti-amyloid mAb): $20,000–$50,000/yr (access-constrained)
- Cardiovascular: $5,000–$25,000/yr
- Metabolic / diabetes: $5,000–$15,000/yr (GLP-1: $12,000–$20,000/yr)

## PEAK PENETRATION BENCHMARKS (5–8 years post-launch)
- First-in-class in major unmet need, no competition: 30–55%
- Best-in-class with clinical differentiation: 20–35%
- Me-too entrant in crowded market: 8–18%
- Label expansion (additional indication for approved drug): 10–20% incremental
- Combination / adjuvant use: 15–30%

## COMPARABLE DRUG METHODOLOGY
Anchor estimates on real-world named comparables. Priority:
1. Same mechanism in same indication (ideal comp)
2. Same indication, different mechanism
3. Same mechanism, different indication (scale for prevalence)
Always adjust for label breadth, launch timing, pricing era, and competitive dynamics.

## BULL / BASE / BEAR LOGIC
- Bull: +40–80% above base (best-case label, fast uptake, pricing strength, combo use, ex-US outperformance)
- Bear: -40–60% below base (pricing pressure, competitive crowding, safety signal, narrow label, slow uptake)
- Confidence = "high" if ≥2 named analyst estimates found; "medium" if 1 estimate or clear market-size data; "low" if pure model

## RULES
- Express ALL monetary values in USD millions (M)
- tamM = drug-specific addressable market in $M (eligible patients × annual price). MUST satisfy: tamM × penetrationPct / 100 ≈ peakSalesM. Do NOT use total disease category market.
- If analyst search results contain explicit estimates, extract and cite them verbatim; never fabricate source names or numbers
- reasoning must be exactly 3–4 sentences covering: (1) patient population size & eligible subset, (2) pricing assumption & comparable drug anchor, (3) penetration rationale, (4) key risk or upside driver
- Never return peakSalesM = 0 — always provide a best-effort estimate. Flag confidence as "low" if purely estimated.
- Return ONLY valid JSON — no markdown fences, no extra text`;

async function analyzeRevenueWithClaude(
  drug: string,
  phase: string,
  sponsor: string | undefined,
  indications: string[]
): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const schema = `{
  "indications": [
    {
      "indication": string,
      "peakSalesM": number,
      "bullM": number,
      "bearM": number,
      "confidence": "high" | "medium" | "low",
      "reasoning": string,
      "analystEstimates": [{ "source": string, "url": string|null, "estimateM": number, "year": number|null, "quote": string }],
      "marketContext": { "tamM": number|null, "penetrationPct": number|null, "patientPopDesc": string|null, "pricingPerYear": number|null, "competitive": string|null },
      "comps": [{ "drug": string, "indication": string, "peakSalesM": number, "rationale": string }],
      "sources": [{ "label": string, "url": string|null }]
    }
  ]
}`;

  const userContent = `Drug: ${drug}
Development Phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}
Indications to model (${indications.length}): ${indications.join(" | ")}

Search the web for analyst estimates, epidemiology, pricing, and comparable drugs for each indication listed above. Then return JSON exactly matching this schema with ${indications.length} entries in the same order:
${schema}`;

  // Retry up to 5 times with aggressive backoff on 429 rate limits.
  // Revenue fires right after auto-value's 2 Claude calls, so 429s are common.
  let text = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      text = await callClaudeWithSearch({
        anthropicKey: key,
        system: SYSTEM_PROMPT,
        userMessage: userContent,
        maxTokens: 8000,
        maxSearches: Math.min(indications.length * 3, 10),
        serperQueries: indications.flatMap((ind) => [
          `${drug} ${ind} peak sales analyst estimate`,
          `${drug} ${ind} market size`,
        ]).slice(0, 6),
      });
      break; // success — exit retry loop
    } catch (e: any) {
      const is429 = e?.message?.includes("429");
      if (attempt === 4) throw e; // rethrow on final attempt
      // 429: wait 30s, 60s, 90s, 120s. Other errors: 5s.
      const wait = is429 ? (attempt + 1) * 30000 : 5000;
      console.warn(`[revenue] attempt ${attempt + 1} failed (${e?.message}), waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { drug, phase, indications, sponsor } = req.body;
  if (!drug || !Array.isArray(indications) || indications.length === 0) {
    return res.status(400).json({ error: "drug and indications[] required" });
  }

  try {
    const analysis = await analyzeRevenueWithClaude(drug, phase, sponsor, indications);

    // Realign by index, fill gaps if Claude returns wrong count
    const rawInds: any[] = analysis.indications || [];
    const aligned = indications.map((ind: string, i: number) => {
      const found = rawInds[i] || rawInds.find((r: any) =>
        r.indication?.toLowerCase().includes(ind.toLowerCase().split(" ")[0].toLowerCase())
      );
      return found || {
        indication: ind, peakSalesM: 0, bullM: 0, bearM: 0,
        confidence: "low", reasoning: "Analysis unavailable for this indication.",
        analystEstimates: [], marketContext: {}, comps: [], sources: [],
      };
    });

    return res.status(200).json({ drug, phase, indications: aligned });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Revenue analysis failed" });
  }
}
