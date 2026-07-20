/**
 * Customer-discovery survey — shared definitions for all three audience segments.
 * Used by the public survey page, the admin results page, and the AI analysis prompt
 * so segment ids, question ids, and labels stay consistent everywhere.
 *
 * Segment → product mapping:
 *   biopharma       → Strategic Advisor product (R&D decision makers)
 *   biopharma_ma_bd → Valuation product only (M&A / BD)
 *   vc_pe           → Strategic Advisor product
 *   hedge_fund      → Valuation product only
 */

export type SegmentId = "biopharma" | "biopharma_ma_bd" | "vc_pe" | "hedge_fund";

export type Segment = {
  id: SegmentId;
  /** Respondent-facing dropdown label */
  label: string;
  /** Internal product mapping, shown in the admin view */
  product: "Strategic Advisor" | "Valuation";
  /** Card tag prefix in the admin view: B1, V1, H1, ... */
  tagPrefix: string;
};

export const SEGMENTS: Segment[] = [
  { id: "biopharma", label: "Biopharma R&D Decision Maker", product: "Strategic Advisor", tagPrefix: "B" },
  { id: "biopharma_ma_bd", label: "Biopharma M&A / BD", product: "Valuation", tagPrefix: "M" },
  { id: "vc_pe", label: "VC / Private equity investor", product: "Strategic Advisor", tagPrefix: "V" },
  { id: "hedge_fund", label: "Hedge fund / public equities investor", product: "Valuation", tagPrefix: "H" },
];

export const DEFAULT_SEGMENT: SegmentId = "biopharma"; // legacy responses had no segment field

export type SurveyQuestion = {
  id: string;
  /** Full question text shown to the respondent */
  label: string;
  /** Short label used in results tables and the analysis prompt */
  short: string;
  kind: "text" | "textarea" | "choice";
  optional?: boolean;
  /** Sub-question attached to the previous one — not numbered */
  sub?: boolean;
  choices?: string[];
  placeholder?: string;
  hint?: string;
  /** 0 = respondent info, 1 = Part 1, 2 = Part 2 */
  part: 0 | 1 | 2;
};

const Q0: SurveyQuestion = {
  id: "q0",
  label: "Your name, role, and organization",
  short: "Name / role / organization",
  kind: "text",
  placeholder: "e.g., Development Program Lead at top 10 pharma",
  hint: "Feel free to be generic if more comfortable — such as “Development Program Lead at top 10 pharma”.",
  part: 0,
};

const Q6_DETAIL: SurveyQuestion = {
  id: "q6detail",
  label: "Anything to add — how often, in what form?",
  short: "Frequency detail",
  kind: "textarea",
  optional: true,
  sub: true,
  placeholder: "Anything to add — how often, in what form?",
  part: 1,
};

// ─── Biopharma company (Strategic Advisor product) ────────────────────────────
const BIOPHARMA_QUESTIONS: SurveyQuestion[] = [
  Q0,
  {
    id: "q1",
    label:
      "Think of a real strategic R&D or portfolio decision in the last year or so where the options had genuinely different value implications — an indication choice, a trial design, a go/no-go, a partnering call, whatever comes to mind. What was the decision?",
    short: "What was the decision?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q2",
    label: "How did the team actually get to an answer — what analysis, tools, or people did you lean on?",
    short: "How did the team get to an answer?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q3",
    label: "What was hardest, slowest, or most debated in getting to a decision?",
    short: "Hardest / slowest / most debated",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q4",
    label:
      "When someone challenged the assumptions — leadership, a committee, a partner — how well did the analysis hold up? Could you re-run it fast, or was it fragile?",
    short: "How did the analysis hold up when challenged?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q5",
    label: "Were there analyses the team wanted but did not have time, data, or confidence to produce?",
    short: "Analyses wanted but not produced",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q6",
    label: "Is this kind of decision a one-off, or does your team face some version of it regularly?",
    short: "One-off or regular?",
    kind: "choice",
    choices: ["Mostly a one-off", "Comes up occasionally", "We face some version of it regularly"],
    part: 1,
  },
  Q6_DETAIL,
  {
    id: "q7",
    label:
      "For the specific decision you just walked me through — would you have actually used something like this in that process? If yes, where exactly would it have plugged in? And what would have made you not bother?",
    short: "Would you have used this? Where / why not?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q8",
    label:
      "If yes — what would a tool like this have to prove before you'd trust its number in a real decision that leadership sees? What about using it systematically as part of your R&D portfolio decision-making?",
    short: "What would it have to prove to be trusted?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q9",
    label:
      "If yes — how likely is it that your internal organization would build and provide a sufficient tool itself, rather than outsourcing?",
    short: "Build internally vs. outsource",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q10",
    label:
      "If you'd outsource — what price range pops into your mind that would make you immediately push for approval?",
    short: "Price range for immediate approval",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q11",
    label:
      "Who else in the organization feels this pain most directly — portfolio strategy, finance, BD, commercial, clinical development, someone else? Is there someone you think I should speak with to understand this workflow better?",
    short: "Who else feels this pain / referrals",
    kind: "textarea",
    optional: true,
    part: 2,
  },
];

// ─── Biopharma M&A / BD (Valuation product only) — shell draft ────────────────
const BIOPHARMA_MA_BD_QUESTIONS: SurveyQuestion[] = [
  Q0,
  {
    id: "q1",
    label:
      "Think of a real in-licensing, out-licensing, acquisition, or partnering evaluation in the last year or so where the asset's value or risk-adjusted value drove the call. What was the deal decision?",
    short: "What was the deal decision?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q2",
    label:
      "How did the team actually get to a number — internal valuation models, bankers or consultants, committee input, something else?",
    short: "How did the team get to a number?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q3",
    label: "What was hardest, slowest, or most debated in agreeing on the asset's value?",
    short: "Hardest / slowest / most debated",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q4",
    label:
      "When the assumptions were challenged — your own leadership, the deal committee, or the other side of the table — how well did the valuation hold up? Could you re-run it fast, or was it fragile?",
    short: "How did the valuation hold up when challenged?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q5",
    label:
      "Were there analyses the team wanted but did not have time, data, or confidence to produce before the deal decision?",
    short: "Analyses wanted but not produced",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q6",
    label: "Is this kind of evaluation a one-off, or does your team face some version of it regularly?",
    short: "One-off or regular?",
    kind: "choice",
    choices: ["Mostly a one-off", "Comes up occasionally", "We face some version of it regularly"],
    part: 1,
  },
  Q6_DETAIL,
  {
    id: "q7",
    label:
      "For the specific deal you just walked me through — would you have actually used something like this? If yes, where exactly — asset screening, diligence, deal committee prep, negotiation support? And what would have made you not bother?",
    short: "Would you have used this? Where / why not?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q8",
    label:
      "If yes — what would it have to prove before you'd put its number in front of your deal committee, or use it to push back on a counterparty's number? What about using it systematically across your BD pipeline?",
    short: "What would it have to prove to be trusted?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q9",
    label:
      "If yes — how likely is it that your internal organization would build and provide a sufficient tool itself, rather than outsourcing?",
    short: "Build internally vs. outsource",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q10",
    label:
      "If you'd outsource — what price range pops into your mind that would make you immediately push for approval?",
    short: "Price range for immediate approval",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q11",
    label:
      "Who else feels this pain most directly — search & evaluation, corporate development, finance, portfolio strategy, someone else? Is there someone you think I should speak with to understand this workflow better?",
    short: "Who else feels this pain / referrals",
    kind: "textarea",
    optional: true,
    part: 2,
  },
];

// ─── VC / PE (Strategic Advisor product) — shell draft ────────────────────────
const VC_PE_QUESTIONS: SurveyQuestion[] = [
  Q0,
  {
    id: "q1",
    label:
      "Think of a real investment decision in the last year or so where a biopharma asset's value or risk-adjusted value drove the call — a new investment, a follow-on, a pass, a term negotiation, whatever comes to mind. What was the decision?",
    short: "What was the decision?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q2",
    label:
      "How did the team actually get to conviction — what diligence, models, external advisors, or experts did you lean on?",
    short: "How did the team get to conviction?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q3",
    label: "What was hardest, slowest, or most debated in getting to a yes or a no?",
    short: "Hardest / slowest / most debated",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q4",
    label:
      "When someone challenged the assumptions — your investment committee, an LP, a co-investor — how well did the analysis hold up? Could you re-run it fast, or was it fragile?",
    short: "How did the analysis hold up when challenged?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q5",
    label:
      "Were there analyses the team wanted but did not have time, data, or confidence to produce before the decision?",
    short: "Analyses wanted but not produced",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q6",
    label: "Is this kind of decision a one-off, or does your fund face some version of it regularly?",
    short: "One-off or regular?",
    kind: "choice",
    choices: ["Mostly a one-off", "Comes up occasionally", "We face some version of it regularly"],
    part: 1,
  },
  Q6_DETAIL,
  {
    id: "q7",
    label:
      "For the specific decision you just walked me through — would you have actually used something like this? If yes, where exactly would it have plugged in — screening, deep diligence, IC prep, post-investment? And what would have made you not bother?",
    short: "Would you have used this? Where / why not?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q8",
    label:
      "If yes — what would a tool like this have to prove before you'd put its number in front of your investment committee? What about using it systematically across your deal flow?",
    short: "What would it have to prove to be trusted?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q9",
    label:
      "If yes — how likely is it that your fund would build something sufficient internally (analysts, data team) rather than buying it?",
    short: "Build internally vs. buy",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q10",
    label: "If you'd buy — what price range pops into your mind that would make it an immediate yes?",
    short: "Price range for an immediate yes",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q11",
    label:
      "Who else feels this pain most directly — partners, principals, your portfolio companies' boards, someone else? Is there someone you think I should speak with to understand this workflow better?",
    short: "Who else feels this pain / referrals",
    kind: "textarea",
    optional: true,
    part: 2,
  },
];

// ─── Hedge fund / public equities (Valuation product only) — shell draft ─────
const HEDGE_FUND_QUESTIONS: SurveyQuestion[] = [
  Q0,
  {
    id: "q1",
    label:
      "Think of a real position or trade decision in the last year or so where a biopharma pipeline asset's value or probability-adjusted value drove the thesis — initiating a position, sizing around a catalyst, an exit, a short, whatever comes to mind. What was the decision?",
    short: "What was the decision?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q2",
    label:
      "How did you actually build the thesis — internal models, sell-side research, expert networks, data services?",
    short: "How was the thesis built?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q3",
    label: "What was hardest or slowest in underwriting the pipeline's value?",
    short: "Hardest / slowest to underwrite",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q4",
    label:
      "When the thesis was challenged — a PM, risk, new data — how fast could you re-run the numbers? Did the analysis hold up?",
    short: "How did the thesis hold up when challenged?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q5",
    label:
      "Were there analyses you wanted but did not have time, data, or confidence to produce — catalyst scenarios, competitive entries, indication expansions?",
    short: "Analyses wanted but not produced",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q6",
    label: "Is this kind of underwriting a one-off, or part of how you work every week?",
    short: "One-off or regular?",
    kind: "choice",
    choices: ["Mostly a one-off", "Comes up occasionally", "It's core to how we work"],
    part: 1,
  },
  Q6_DETAIL,
  {
    id: "q7",
    label:
      "For the specific thesis you just walked me through — would you have actually used something like this? If yes, where exactly — idea screening, catalyst prep, position sizing, monitoring? And what would have made you not bother?",
    short: "Would you have used this? Where / why not?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q8",
    label:
      "If yes — what would it have to prove before you'd trust its number in a live position? What about making it a systematic part of your process?",
    short: "What would it have to prove to be trusted?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q9",
    label:
      "If yes — how likely is it that your fund would build something sufficient internally rather than paying for an external tool?",
    short: "Build internally vs. buy",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q10",
    label: "If external — what price range pops into your mind that would make it an immediate yes?",
    short: "Price range for an immediate yes",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q11",
    label:
      "Who else feels this pain most directly — other analysts, PMs, the data team, someone else? Is there someone you think I should speak with to understand this workflow better?",
    short: "Who else feels this pain / referrals",
    kind: "textarea",
    optional: true,
    part: 2,
  },
];

export const QUESTIONS_BY_SEGMENT: Record<SegmentId, SurveyQuestion[]> = {
  biopharma: BIOPHARMA_QUESTIONS,
  biopharma_ma_bd: BIOPHARMA_MA_BD_QUESTIONS,
  vc_pe: VC_PE_QUESTIONS,
  hedge_fund: HEDGE_FUND_QUESTIONS,
};

// ─── Part 2 concept text per segment ──────────────────────────────────────────
export const CONCEPT_BY_SEGMENT: Record<SegmentId, string[]> = {
  biopharma: [
    "It's an AI platform that builds a defensible, sourced valuation for an asset — from preclinical to LCM — with industry-leading AI-driven probability calculations, and lets you compare the value of strategic options: indication sequencing, trial design, partnering, go/no-go — with the reasoning shown and traceable, not a black box.",
    "You could add and compare new options, or changes to options, instantly and as often as you like, simply by asking in plain language.",
  ],
  biopharma_ma_bd: [
    "It's an AI platform that builds a defensible, sourced valuation for any drug asset or company — probability-adjusted NPV from preclinical to LCM — with industry-leading AI-driven probability calculations and every number traceable to its sources, not a black box.",
    "You could re-run the valuation instantly as deal terms or new data change — during diligence or live negotiations — simply by asking in plain language.",
  ],
  vc_pe: [
    "It's an AI platform that builds a defensible, sourced valuation for any drug asset — from preclinical to LCM — with industry-leading AI-driven probability calculations, and lets you stress-test the strategic options behind a deal: indication sequencing, trial design, partnering structures, follow-on scenarios — with the reasoning shown and traceable, not a black box.",
    "You could add and compare new scenarios instantly, as often as you like, simply by asking in plain language — during diligence or after the investment.",
  ],
  hedge_fund: [
    "It's an AI platform that builds a defensible, sourced valuation for drug pipeline assets and whole biopharma companies — probability-adjusted NPV per asset, from preclinical to LCM, with industry-leading AI-driven probability calculations and every number traceable to its sources, not a black box.",
    "You could re-run the valuation instantly when something changes — a readout, a competitor event, an FDA decision — simply by asking in plain language.",
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function isSegmentId(v: unknown): v is SegmentId {
  return v === "biopharma" || v === "biopharma_ma_bd" || v === "vc_pe" || v === "hedge_fund";
}

export function segmentById(id: SegmentId): Segment {
  return SEGMENTS.find((s) => s.id === id) || SEGMENTS[0];
}

export function questionIds(segment: SegmentId): string[] {
  return QUESTIONS_BY_SEGMENT[segment].map((q) => q.id);
}

/** Questions counted toward the respondent progress bar (optional ones excluded). */
export function progressIds(segment: SegmentId): string[] {
  return QUESTIONS_BY_SEGMENT[segment].filter((q) => !q.optional).map((q) => q.id);
}

/** Sequential numbering for Part 1/2 questions (sub-questions unnumbered). */
export function numberingFor(segment: SegmentId): Record<string, number> {
  const map: Record<string, number> = {};
  let n = 0;
  for (const q of QUESTIONS_BY_SEGMENT[segment]) {
    if (q.part > 0 && !q.sub) {
      n += 1;
      map[q.id] = n;
    }
  }
  return map;
}
