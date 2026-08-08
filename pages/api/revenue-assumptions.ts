import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";
import { validateElicitationFindings } from "../../lib/elicitation";

// ── Module 3: deterministic coherence checks on the elicited market arithmetic ─────────────────
// Pure arithmetic on the emission's own numbers; incoherence is NAMED, never silently fixed
// (§1.5). Tolerances ±33% (ratio outside [0.75, 1.33]) and the narrow-spread floor 40% are
// hand-set provisional rails, labeled as such in the messages.
function coherenceFlags(a: {
  peakSalesM?: number; bearM?: number; bullM?: number;
  marketContext?: { tamM?: number | null; penetrationPct?: number | null; pricingPerYear?: number | null; eligiblePatients?: number | null };
}): string[] {
  const f: string[] = [];
  const mc = a.marketContext ?? {};
  const { tamM, penetrationPct, pricingPerYear, eligiblePatients } = mc;
  if (typeof eligiblePatients === "number" && eligiblePatients > 0 && typeof pricingPerYear === "number" && pricingPerYear > 0 && typeof tamM === "number" && tamM > 0) {
    const impliedTamM = (eligiblePatients * pricingPerYear) / 1e6;
    const r = impliedTamM / tamM;
    if (r > 1.33 || r < 0.75) {
      f.push(`TAM arithmetic incoherent: ${eligiblePatients.toLocaleString("en-US")} patients × $${Math.round(pricingPerYear / 1000)}k/yr implies ~$${Math.round(impliedTamM).toLocaleString("en-US")}M, but tamM says $${Math.round(tamM).toLocaleString("en-US")}M (${r.toFixed(1)}× apart) — at least one of the three numbers is wrong (±33% provisional tolerance)`);
    }
  } else if (typeof tamM === "number" && tamM > 0 && !(typeof eligiblePatients === "number" && eligiblePatients > 0)) {
    f.push("eligiblePatients not emitted — the TAM arithmetic is unverifiable (the 8/8 live run's $3B-TAM-vs-$12B-patient-math contradiction was only catchable with a structured count)");
  }
  if (typeof tamM === "number" && tamM > 0 && typeof penetrationPct === "number" && penetrationPct > 0 && typeof a.peakSalesM === "number" && a.peakSalesM > 0) {
    const impliedPeak = (tamM * penetrationPct) / 100;
    const r = impliedPeak / a.peakSalesM;
    if (r > 1.33 || r < 0.75) {
      f.push(`peak arithmetic incoherent: TAM $${Math.round(tamM).toLocaleString("en-US")}M × ${penetrationPct}% implies ~$${Math.round(impliedPeak).toLocaleString("en-US")}M vs stated peak $${Math.round(a.peakSalesM).toLocaleString("en-US")}M (±33% provisional tolerance)`);
    }
  }
  if (typeof a.bearM === "number" && a.bearM > 0 && typeof a.bullM === "number" && a.bullM > 0 && typeof a.peakSalesM === "number" && a.peakSalesM > 0) {
    if (!(a.bearM < a.peakSalesM && a.peakSalesM < a.bullM)) {
      f.push(`bear/base/bull ordering violated ($${a.bearM}M / $${a.peakSalesM}M / $${a.bullM}M) — the elicited range is unusable until reconciled`);
    } else if ((a.bullM - a.bearM) / a.peakSalesM < 0.4) {
      f.push(`p05–p95 spread is only ${Math.round(((a.bullM - a.bearM) / a.peakSalesM) * 100)}% of the base — suspiciously narrow for a pre-launch asset (experts under-cover ranges; 40% floor is a provisional rail)`);
    }
  }
  return f;
}

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

## ELICITATION PROTOCOL — you are the expert under a facilitated probability elicitation
Work EXTREMES FIRST, center last (anchoring runs downhill from the first number you commit to):
1. bearM = your p05: only a ~5% chance peak sales land BELOW this (a real scenario — narrow label,
   pricing collapse, potent competitor — not a % template off the base).
2. bullM = your p95: only a ~5% chance peak sales land ABOVE this.
3. peakSalesM = your median, and it MUST lie between bearM and bullM.
NEVER derive bear/bull as ±X% of the base — that is the anchoring failure this protocol replaces.
Experts systematically under-cover the true range; when in doubt, widen. A reviewer will audit
your rationale for anchoring on comp peaks, recency-driven recall, base-rate neglect on
penetration, and motivated optimism — write reasoning that survives that audit.

## STRUCTURED MARKET ARITHMETIC (verified deterministically — incoherence is flagged to the user)
- marketContext.eligiblePatients = the drug-eligible treated pool (a COUNT, global basis consistent
  with your peak). REQUIRED whenever tamM is given.
- The identities MUST hold: tamM ≈ eligiblePatients × pricingPerYear / 1,000,000 and
  peakSalesM ≈ tamM × penetrationPct / 100. If your narrative population and your TAM disagree,
  FIX THE NUMBERS, not the prose.
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
      "marketContext": { "tamM": number|null, "penetrationPct": number|null, "eligiblePatients": number|null, "patientPopDesc": string|null, "pricingPerYear": number|null, "competitive": string|null },
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

    // Module 3: deterministic coherence checks on each indication's elicited arithmetic
    for (const a of aligned) {
      const flags = coherenceFlags(a);
      if (flags.length) a.coherenceFlags = flags;
    }

    // Module 3: the facilitator checker — one batched call auditing the revenue RATIONALES
    // (never proposing numbers). Gated by validateElicitationFindings; fail-open with a health
    // marker so silence always means "did not run" is impossible.
    let elicitationReview: { findings: { severity: string; message: string }[]; flags: string[] } = {
      findings: [{ severity: "info", message: "AI checker unavailable this run (fail-open) — revenue rationales are UNREVIEWED" }],
      flags: [],
    };
    try {
      const key = process.env.ANTHROPIC_API_KEY!;
      const digest = aligned.map((a: any) => {
        const mc = a.marketContext || {};
        return `"${a.indication}": peak $${a.peakSalesM}M (p05 $${a.bearM}M / p95 $${a.bullM}M, confidence ${a.confidence}); TAM $${mc.tamM ?? "?"}M = ${mc.eligiblePatients?.toLocaleString?.("en-US") ?? "?"} patients × $${mc.pricingPerYear ?? "?"}/yr; penetration ${mc.penetrationPct ?? "?"}%; comps: ${(a.comps || []).map((c: any) => `${c.drug} $${c.peakSalesM}M`).join(", ") || "none"}; reasoning: ${a.reasoning}`;
      }).join("\n");
      const checkRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1200,
          messages: [{
            role: "user",
            content: `You are the FACILITATOR auditing a sell-side analyst's revenue elicitations for ${drug} (${phase}). Audit each RATIONALE — never propose a replacement number; any number you mention must be copied from the input.

${digest}

Report ONLY genuine issues (max 5):
1. Anchoring: peak suspiciously equal to a comp's peak, a round market-report number, or a template % of TAM.
2. Motivated optimism / pessimism: every lever leaning the same direction; penetration borrowed from a comp's most favorable reading.
3. Availability/recency: rationale dominated by the newest headline (an approval, one readout) rather than the full competitive picture.
4. Base-rate neglect: penetration or price out of line with what comparable launches ACTUALLY achieved (cite the input's own comps).
5. Internal consistency: reasoning that contradicts the numbers, comps that contradict the price/share claims, bear/bull that ignore named risks.

Respond STRICT JSON only:
{"findings":[{"quantity":"peakSales|bearBull|tam|penetration|wac|eligibleCount|comps|general","severity":"high|medium|info","message":"one or two sentences, name the indication"}]}
Empty findings array if everything is defensible.`,
          }],
        }),
      });
      if (checkRes.ok) {
        const cd = (await checkRes.json()) as { content?: { type: string; text?: string }[] };
        const ctext = (cd.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
        const cs = ctext.indexOf("{"); const ce = ctext.lastIndexOf("}");
        let cparsed: unknown = null;
        if (cs >= 0 && ce > cs) { try { cparsed = JSON.parse(ctext.slice(cs, ce + 1)); } catch { cparsed = null; } }
        const gated = validateElicitationFindings(cparsed, ["peakSales", "bearBull", "tam", "penetration", "wac", "eligibleCount", "comps", "general"]);
        elicitationReview = {
          findings: gated.findings.length ? gated.findings : [{ severity: "info", message: "AI checker reviewed the revenue elicitations — no findings" }],
          flags: gated.flags,
        };
      }
    } catch (checkErr) {
      console.error("[revenue] elicitation checker failed (fail-open):", (checkErr as Error)?.message);
    }

    return res.status(200).json({ drug, phase, indications: aligned, elicitationReview });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Revenue analysis failed" });
  }
}
