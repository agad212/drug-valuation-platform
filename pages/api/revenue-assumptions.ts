import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";
import { revenueCoherenceFlags } from "../../lib/elicitation";
import { runElicitationChecker } from "../../lib/elicitation-checker";
import { pinEpi, EPI_GLOBAL_TO_US_MAX } from "../../lib/indication-benchmarks";

// Module 3 coherence rails live in lib/elicitation.ts (revenueCoherenceFlags) — named, tested
// tolerances shared with the client instead of magic literals duplicated per surface.

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

## EPI FUNNEL — BUILD the patient count, never assert it (verified deterministically)
marketContext.epi is REQUIRED whenever eligiblePatients is given:
  prevalence (worldwide patients with the disease) × diagnosedPct × treatedPct (on/eligible for drug
  therapy under the expected label) × accessiblePct (in markets where the drug will actually be sold
  and reimbursed) ≈ eligiblePatients.
Each step needs a source in epi.basis. Search for PATIENT-denominated epidemiology (prevalence
studies, registries, treated-population analyses), not revenue-denominated market reports — do not
back-solve patients from a "$X billion market" figure. A funnel that doesn't multiply out to your
stated count is flagged to the user. When LIBRARY EPI FACTS are provided below, reconcile with those
cited bands or state explicitly why you deviate.

## AT-LAUNCH COMPETITIVE SET — share is defended against the field AT LAUNCH, not today
competitorsAtLaunch is REQUIRED whenever penetrationPct is given: the named competitors you expect
ON THE MARKET IN THE LAUNCH YEAR stated for the indication. Statuses: "approved-incumbent" (on the
market today and still relevant at launch), "likely-approved-by-launch" (positive Phase 3 / filed —
include these; ignoring a drug with positive pivotal data is the classic blindspot),
"generic" (loss of exclusivity by launch), "uncertain" (Phase 3 outcome unknown). Your
penetrationPct rationale must name why this drug wins that share against THAT set.

## CONDITIONAL ON APPROVAL — the #1 double-count to avoid
ALL revenue numbers (peakSalesM, bearM, bullM, penetrationPct) are CONDITIONAL ON THE DRUG BEING
APPROVED. The valuation engine multiplies by P(approval) separately. NEVER discount penetration or
peak because the asset is early-phase, unproven, or "carries clinical and regulatory risk" — that
double-counts risk the engine already prices. Legitimate discounts: competition at launch, label
breadth, access/reimbursement, pricing pressure. A reviewer specifically audits for this violation.

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
  indications: string[],
  launchYears: (number | null)[] = []
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
      "marketContext": { "tamM": number|null, "penetrationPct": number|null, "eligiblePatients": number|null, "patientPopDesc": string|null, "pricingPerYear": number|null, "competitive": string|null, "epi": { "prevalence": number|null, "diagnosedPct": number|null, "treatedPct": number|null, "accessiblePct": number|null, "basis": string|null } },
      "competitorsAtLaunch": [{ "name": string, "status": "approved-incumbent" | "likely-approved-by-launch" | "generic" | "uncertain", "note": string|null }],
      "comps": [{ "drug": string, "indication": string, "peakSalesM": number, "rationale": string }],
      "sources": [{ "label": string, "url": string|null }]
    }
  ]
}`;

  // Per-indication lines carry the expected launch year (the competitor set is judged AT LAUNCH,
  // not today) and any LIBRARY EPI FACTS (cited bands the funnel must reconcile with).
  const indLines = indications.map((ind, i) => {
    const ly = launchYears[i];
    const pin = pinEpi(ind);
    return `- ${ind}${ly ? ` (assume launch ~${ly} — judge competitorsAtLaunch against THAT year)` : ""}${pin ? `\n  LIBRARY EPI FACTS (cited — reconcile your funnel with these bands or state why you deviate): ${pin.source}` : ""}`;
  });
  const userContent = `Drug: ${drug}
Development Phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}
Indications to model (${indications.length}):
${indLines.join("\n")}

Search the web for analyst estimates, PATIENT-denominated epidemiology, pricing, comparable drugs, and the launch-year competitive pipeline for each indication listed above. Then return JSON exactly matching this schema with ${indications.length} entries in the same order:
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
  const __t0 = Date.now(); // serverless budget clock — the checker skips itself near the kill line

  const { drug, phase, indications, sponsor } = req.body;
  if (!drug || !Array.isArray(indications) || indications.length === 0) {
    return res.status(400).json({ error: "drug and indications[] required" });
  }
  // Expected launch year per indication (aligned to indications[]) — the at-launch competitor set
  // is judged against this year, not against today's market.
  const launchYears: (number | null)[] = Array.isArray(req.body.launchYears)
    ? (req.body.launchYears as unknown[]).map((y) => (typeof y === "number" && Number.isFinite(y) ? y : null))
    : [];

  try {
    const analysis = await analyzeRevenueWithClaude(drug, phase, sponsor, indications, launchYears);

    // Realign by index, fill gaps if Claude returns wrong count
    const rawInds: any[] = analysis.indications || [];
    // Numeric normalization: the raw LLM object passes straight to the client, and an omitted or
    // string-valued field ("3,000") otherwise renders as $NaN and can write NaN into the engine
    // on Apply (8/8 code-review finding). Finite number → kept; anything else → fallback.
    const fin = (x: unknown): number | undefined =>
      typeof x === "number" && Number.isFinite(x) ? x : undefined;
    const aligned = indications.map((ind: string, i: number) => {
      const found = rawInds[i] || rawInds.find((r: any) =>
        r.indication?.toLowerCase().includes(ind.toLowerCase().split(" ")[0].toLowerCase())
      );
      if (!found) return {
        indication: ind, peakSalesM: 0, bullM: 0, bearM: 0,
        confidence: "low", reasoning: "Analysis unavailable for this indication.",
        analystEstimates: [], marketContext: {}, comps: [], sources: [],
      };
      const mc = found.marketContext || {};
      // Module 3c whitelist: competitor entries (name/status/note only, capped) + numeric epi funnel.
      const VALID_STATUS = new Set(["approved-incumbent", "likely-approved-by-launch", "generic", "uncertain"]);
      const competitorsAtLaunch = Array.isArray(found.competitorsAtLaunch)
        ? found.competitorsAtLaunch.slice(0, 8).map((c: any) => ({
            name: typeof c?.name === "string" ? c.name.trim().slice(0, 80) : "",
            status: typeof c?.status === "string" && VALID_STATUS.has(c.status.trim()) ? c.status.trim() : "uncertain",
            ...(typeof c?.note === "string" && c.note.trim() ? { note: c.note.trim().slice(0, 160) } : {}),
          })).filter((c: any) => c.name)
        : undefined;
      const epiRaw = mc.epi;
      const epi = epiRaw && typeof epiRaw === "object"
        ? {
            prevalence: fin(epiRaw.prevalence) ?? null,
            diagnosedPct: fin(epiRaw.diagnosedPct) ?? null,
            treatedPct: fin(epiRaw.treatedPct) ?? null,
            accessiblePct: fin(epiRaw.accessiblePct) ?? null,
            basis: typeof epiRaw.basis === "string" && epiRaw.basis.trim() ? epiRaw.basis.trim().slice(0, 500) : null,
          }
        : null;
      return {
        ...found,
        peakSalesM: fin(found.peakSalesM) ?? 0,
        bullM: fin(found.bullM) ?? 0,
        bearM: fin(found.bearM) ?? 0,
        ...(competitorsAtLaunch && competitorsAtLaunch.length ? { competitorsAtLaunch } : {}),
        marketContext: {
          ...mc,
          tamM: fin(mc.tamM) ?? null,
          penetrationPct: fin(mc.penetrationPct) ?? null,
          pricingPerYear: fin(mc.pricingPerYear) ?? null,
          eligiblePatients: fin(mc.eligiblePatients) ?? null,
          epi,
        },
      };
    });

    // Module 3/3c: deterministic coherence checks on each indication's elicited arithmetic,
    // anchored by the library epi pin where one exists (facts before opinions).
    for (const a of aligned) {
      const flags = revenueCoherenceFlags(a, pinEpi(a.indication ?? ""), EPI_GLOBAL_TO_US_MAX);
      if (flags.length) a.coherenceFlags = flags;
    }

    // Module 3: the facilitator checker — one batched call auditing the revenue RATIONALES
    // (never proposing numbers). Transport, timeout, robust JSON parse, findings gate, and the
    // health markers (clean / gate-failure / fail-open / deadline-skip) live in
    // lib/elicitation-checker — shared with the dev-plan checker so the two cannot drift.
    const digest = aligned.map((a: any, i: number) => {
      const mc = a.marketContext || {};
      const epi = mc.epi;
      const funnel = epi && epi.prevalence != null
        ? `${epi.prevalence.toLocaleString?.("en-US") ?? epi.prevalence} prevalent × ${epi.diagnosedPct ?? "?"}% dx × ${epi.treatedPct ?? "?"}% treated${epi.accessiblePct != null ? ` × ${epi.accessiblePct}% accessible` : ""} (basis: ${epi.basis ?? "none"})`
        : "NOT EMITTED";
      const atLaunch = (a.competitorsAtLaunch || []).map((c: any) => `${c.name} [${c.status}]`).join(", ") || "NOT EMITTED";
      return `"${a.indication}": peak $${a.peakSalesM}M (p05 $${a.bearM}M / p95 $${a.bullM}M, confidence ${a.confidence}); TAM $${mc.tamM ?? "?"}M = ${mc.eligiblePatients?.toLocaleString?.("en-US") ?? "?"} patients × $${mc.pricingPerYear ?? "?"}/yr; penetration ${mc.penetrationPct ?? "?"}%; epi funnel: ${funnel}; at launch (~${launchYears[i] ?? "?"}): ${atLaunch}; comps: ${(a.comps || []).map((c: any) => `${c.drug} $${c.peakSalesM}M`).join(", ") || "none"}; reasoning: ${a.reasoning}`;
    }).join("\n");
    const elicitationReview = await runElicitationChecker({
      apiKey: process.env.ANTHROPIC_API_KEY,
      handlerStartMs: __t0,
      subjectLabel: "the revenue rationales",
      allowedQuantities: ["peakSales", "bearBull", "tam", "penetration", "wac", "eligibleCount", "epi", "competition", "conditionality", "comps", "general"],
      prompt: `You are the FACILITATOR auditing a sell-side analyst's revenue elicitations for ${drug} (${phase}). Audit each RATIONALE — never propose a replacement number; any number you mention must be copied from the input.

${digest}

Report ONLY genuine issues (max 5):
1. Anchoring: peak suspiciously equal to a comp's peak, a round market-report number, or a template % of TAM.
2. Motivated optimism / pessimism: every lever leaning the same direction; penetration borrowed from a comp's most favorable reading.
3. Availability/recency: rationale dominated by the newest headline (an approval, one readout) rather than the full competitive picture.
4. Base-rate neglect: penetration or price out of line with what comparable launches ACTUALLY achieved (cite the input's own comps).
5. Internal consistency: reasoning that contradicts the numbers, comps that contradict the price/share claims, bear/bull that ignore named risks.
6. CONDITIONALITY VIOLATION (double-counting): penetration or peak discounted for the drug's OWN clinical/regulatory risk ("still Phase 2", "unproven asset") — revenue here is conditional on approval; only competitive/access/pricing discounts are legitimate.
7. At-launch blindness: share defended against TODAY'S market while the stated at-launch set (or the public record) includes competitors likely approved by launch; or an at-launch set that omits a drug with positive pivotal data.
8. Epi funnel honesty: funnel steps that contradict the cited LIBRARY EPI FACTS or the rationale's own prevalence claims; a count back-solved from a revenue-denominated market report.

Respond STRICT JSON only:
{"findings":[{"quantity":"peakSales|bearBull|tam|penetration|wac|eligibleCount|epi|competition|conditionality|comps|general","severity":"high|medium|info","message":"one or two sentences, name the indication"}]}
Empty findings array if everything is defensible.`,
    });

    return res.status(200).json({ drug, phase, indications: aligned, elicitationReview });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Revenue analysis failed" });
  }
}
