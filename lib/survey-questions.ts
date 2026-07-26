/**
 * Customer-discovery survey v2 — multiple-choice / 5-point-scale format,
 * designed so nothing asks about specific assets, programs, or numbers.
 * Shared by the public survey page, the admin results page, and the AI analysis.
 *
 * Segment → product mapping:
 *   biopharma       → Strategic Advisor (R&D decision makers)
 *   biopharma_ma_bd → Valuation only (M&A / BD leaders)
 *   vc_pe           → Strategic Advisor
 *   hedge_fund      → Valuation only
 *   tech_transfer   → Strategic Advisor
 */

export type SegmentId = "biopharma" | "biopharma_ma_bd" | "vc_pe" | "hedge_fund" | "tech_transfer";

export type Segment = {
  id: SegmentId;
  /** Respondent-facing dropdown label */
  label: string;
  /** Internal product mapping, shown in the admin view */
  product: "Strategic Advisor" | "Valuation";
  /** Card tag prefix in the admin view: B1, M1, V1, H1, T1, ... */
  tagPrefix: string;
};

export const SEGMENTS: Segment[] = [
  { id: "biopharma", label: "Biopharma R&D Decision Maker", product: "Strategic Advisor", tagPrefix: "B" },
  { id: "biopharma_ma_bd", label: "Biopharma M&A / BD Leader", product: "Valuation", tagPrefix: "M" },
  { id: "vc_pe", label: "VC / Private equity investor", product: "Strategic Advisor", tagPrefix: "V" },
  { id: "hedge_fund", label: "Hedge fund / public equities investor", product: "Valuation", tagPrefix: "H" },
  { id: "tech_transfer", label: "University Tech Transfer Office", product: "Strategic Advisor", tagPrefix: "T" },
];

export const DEFAULT_SEGMENT: SegmentId = "biopharma"; // legacy responses had no segment field

export type SurveyQuestion = {
  id: string;
  /** Full question text shown to the respondent */
  label: string;
  /** Short label used in results tables and the analysis prompt */
  short: string;
  kind: "text" | "textarea" | "choice" | "multi" | "scale";
  optional?: boolean;
  /** Sub-question attached to the previous one — not numbered */
  sub?: boolean;
  /** For choice/multi */
  choices?: string[];
  /** For scale: anchor labels at 1 and 5 */
  anchors?: { min: string; max: string };
  /** For scale: all five steps labeled (overrides anchors display) */
  stepLabels?: string[];
  placeholder?: string;
  hint?: string;
  /** 0 = respondent info, 1 = Part 1, 2 = Part 2 */
  part: 0 | 1 | 2;
};

// ─── Small constructors to keep the sets readable ─────────────────────────────
const scale = (
  id: string,
  label: string,
  short: string,
  anchors: { min: string; max: string },
  part: 1 | 2
): SurveyQuestion => ({ id, label, short, kind: "scale", anchors, part });

const steps = (id: string, label: string, short: string, stepLabels: string[], part: 1 | 2): SurveyQuestion => ({
  id,
  label,
  short,
  kind: "scale",
  stepLabels,
  anchors: { min: stepLabels[0], max: stepLabels[stepLabels.length - 1] },
  part,
});

const multi = (id: string, label: string, short: string, choices: string[], part: 1 | 2): SurveyQuestion => ({
  id,
  label,
  short,
  kind: "multi",
  choices,
  part,
});

const pick = (id: string, label: string, short: string, choices: string[], part: 0 | 1 | 2): SurveyQuestion => ({
  id,
  label,
  short,
  kind: "choice",
  choices,
  part,
});

const AGREE = { min: "Strongly disagree", max: "Strongly agree" };
const LEVELS = [
  "Analyst / Associate",
  "Manager / Senior manager",
  "Director or equivalent",
  "VP or equivalent",
  "C-suite / Partner / Head of function",
];
const PRICE_CHOICES = ["<$10k / year", "$10–50k / year", "$50–100k / year", "$100–250k / year", "$250k+ / year", "Can't say"];
const TURNAROUND = ["Days", "1–2 weeks", "~1 month", "1–3 months", "3+ months"];
const TRUST_CORE = [
  "Match our internal models on assets we know",
  "Full source traceability for every number",
  "Published calibration / validation track record",
  "Adoption by peers or big-name organizations",
  "Sign-off from our internal methods team",
  "Nothing would get it there",
];

function aboutYou(roleLabel: string, roleChoices: string[], orgChoices: string[]): SurveyQuestion[] {
  return [
    pick("a_role", roleLabel, "Functional area", roleChoices, 0),
    pick("a_org", "Your organization", "Organization type", orgChoices, 0),
    pick("a_level", "Your level", "Level", LEVELS, 0),
    {
      id: "q0",
      label: "Name / contact",
      short: "Name / contact",
      kind: "text",
      optional: true,
      placeholder: "Only if you're open to a short follow-up conversation",
      hint: "Optional — leave blank to stay anonymous.",
      part: 0,
    },
  ];
}

const openEnd = (short: string): SurveyQuestion => ({
  id: "q_open",
  label: "Anything you'd add — in as general terms as you like.",
  short,
  kind: "textarea",
  optional: true,
  placeholder: "Optional",
  part: 2,
});

// ─── Biopharma R&D Decision Maker (Strategic Advisor) ────────────────────────
const BIOPHARMA_QUESTIONS: SurveyQuestion[] = [
  ...aboutYou(
    "Your functional area",
    ["Portfolio strategy", "Clinical development", "R&D leadership", "Finance / decision science", "Business development", "Other"],
    ["Top-20 pharma", "Mid-size pharma", "Small biotech (<500 people)", "Other"]
  ),
  multi(
    "q_decisions",
    "Which of these value-driven decisions does your team face?",
    "Decision types faced",
    ["Indication selection / sequencing", "Trial design trade-offs", "Go / no-go", "Partnering / licensing", "Portfolio prioritization", "Other"],
    1
  ),
  scale(
    "q_freq",
    "How often does your team face a decision where risk-adjusted asset value materially drives the call?",
    "Decision frequency",
    { min: "Rarely (≤1 / year)", max: "Constantly (weekly)" },
    1
  ),
  steps(
    "q_turnaround",
    "From “question asked” to “analysis ready for a committee” typically takes:",
    "Analysis turnaround",
    TURNAROUND,
    1
  ),
  scale("q_challenge", "“When leadership or a committee challenges our assumptions, the analysis holds up well.”", "Analysis holds up when challenged", AGREE, 1),
  scale("q_rerun", "“If a key assumption changes, we can re-run the full analysis within a day.”", "Can re-run within a day", AGREE, 1),
  scale("q_sourced", "“The probability-of-success numbers we use are well-sourced and defensible rather than judgment calls.”", "PTRS well-sourced", AGREE, 1),
  scale("q_skip_freq", "“We skip analyses we'd want because of time, data, or resource constraints.”", "Analyses skipped", { min: "Almost never", max: "Constantly" }, 1),
  multi(
    "q_skipped",
    "Which analyses most often get skipped?",
    "What gets skipped",
    ["Indication sequencing comparisons", "Trial design value trade-offs", "Updated PTRS when new data lands", "Competitive / scenario modeling", "Partnering vs. go-alone valuation", "None"],
    1
  ),
  scale("q_disagree", "“Disagreement over assumptions — not missing data — is the biggest source of delay.”", "Assumption disagreement delays", AGREE, 1),
  scale("q_use", "“I would have actually used a tool like this in a recent decision process.”", "Would use", { min: "Definitely not", max: "Definitely yes" }, 2),
  multi(
    "q_plugin",
    "Where would it plug in?",
    "Where it plugs in",
    ["Early option framing", "Building the base-case valuation", "Committee / leadership prep", "Live what-ifs during discussion", "Monitoring after the decision", "It wouldn't"],
    2
  ),
  multi("q_trust", "What would it need before you'd trust its number in a leadership-facing decision?", "Trust requirements", TRUST_CORE, 2),
  scale("q_build", "“My organization would sooner build something sufficient internally than buy it.”", "Build vs. buy lean", AGREE, 2),
  pick("q_price", "What annual price would feel like an easy “push for approval”?", "Price anchor", PRICE_CHOICES, 2),
  multi(
    "q_pain",
    "Who feels this pain most?",
    "Who feels the pain",
    ["Portfolio strategy", "Finance / decision science", "Business development", "Commercial", "Clinical development", "R&D leadership"],
    2
  ),
  openEnd("Open comments"),
];

// ─── Biopharma M&A / BD Leader (Valuation only) ───────────────────────────────
const BIOPHARMA_MA_BD_QUESTIONS: SurveyQuestion[] = [
  ...aboutYou(
    "Your functional area",
    ["Corporate / business development", "Search & evaluation", "Finance", "Strategy", "Executive leadership", "Other"],
    ["Top-20 pharma", "Mid-size pharma", "Small biotech (<500 people)", "Other"]
  ),
  multi(
    "q_decisions",
    "Which of these deal evaluations does your team face?",
    "Deal types faced",
    ["In-licensing", "Out-licensing", "Acquisition evaluation", "Divestiture", "Partnering / co-development structures", "Other"],
    1
  ),
  scale(
    "q_freq",
    "How often does a deal evaluation hinge on a risk-adjusted asset valuation?",
    "Deal-valuation frequency",
    { min: "Rarely (≤1 / year)", max: "Constantly (weekly)" },
    1
  ),
  steps(
    "q_turnaround",
    "From “target identified” to “valuation ready for a deal committee” typically takes:",
    "Valuation turnaround",
    TURNAROUND,
    1
  ),
  scale("q_challenge", "“Our valuations hold up when challenged — by leadership or by the other side of the table.”", "Valuation holds up when challenged", AGREE, 1),
  scale("q_rerun", "“When deal terms or assumptions change, we can re-run the valuation the same day.”", "Can re-run same day", AGREE, 1),
  scale("q_sourced", "“The probability-of-success inputs in our deal models are well-sourced and defensible.”", "PTRS well-sourced", AGREE, 1),
  scale("q_skip_freq", "“We skip analyses we'd want before a deal decision because of time or bandwidth.”", "Analyses skipped", { min: "Almost never", max: "Constantly" }, 1),
  multi(
    "q_skipped",
    "Which analyses most often get skipped?",
    "What gets skipped",
    ["Alternative deal-structure scenarios", "Updated PTRS when new data lands", "Competitive / landscape modeling", "Indication-sequencing upside", "Counterparty-perspective valuation", "None"],
    1
  ),
  scale("q_disagree", "“Internal misalignment on assumptions delays deals more than missing data does.”", "Assumption disagreement delays", AGREE, 1),
  scale("q_use", "“I would have actually used a tool like this in a recent deal evaluation.”", "Would use", { min: "Definitely not", max: "Definitely yes" }, 2),
  multi(
    "q_plugin",
    "Where would it plug in?",
    "Where it plugs in",
    ["Target screening", "Diligence / base-case valuation", "Deal committee prep", "Negotiation support (live what-ifs)", "Post-deal monitoring", "It wouldn't"],
    2
  ),
  multi("q_trust", "What would it need before you'd put its number in front of a deal committee — or use it against a counterparty's number?", "Trust requirements", TRUST_CORE, 2),
  scale("q_build", "“My organization would sooner build something sufficient internally than buy it.”", "Build vs. buy lean", AGREE, 2),
  pick("q_price", "What annual price would feel like an easy “push for approval”?", "Price anchor", PRICE_CHOICES, 2),
  multi(
    "q_pain",
    "Who feels this pain most?",
    "Who feels the pain",
    ["Corporate development", "Search & evaluation", "Finance", "R&D / portfolio strategy", "Executive leadership"],
    2
  ),
  openEnd("Open comments"),
];

// ─── VC / PE (Strategic Advisor) ──────────────────────────────────────────────
const VC_PE_QUESTIONS: SurveyQuestion[] = [
  ...aboutYou(
    "Your role",
    ["Investment team — Partner level", "Investment team — Principal / VP", "Analyst / Associate", "Operating / platform team", "Other"],
    ["Large multi-stage fund (>$1B AUM)", "Mid-size fund", "Small / seed fund", "PE / growth equity", "Other"]
  ),
  multi(
    "q_decisions",
    "Which of these investment decisions does your team face?",
    "Decision types faced",
    ["New investment", "Follow-on", "Pass / kill decisions", "Term negotiation", "Portfolio company strategy support", "Other"],
    1
  ),
  scale(
    "q_freq",
    "How often does an investment call hinge on a risk-adjusted view of a drug asset's value?",
    "Decision frequency",
    { min: "Rarely (≤1 / year)", max: "Constantly (weekly)" },
    1
  ),
  steps(
    "q_turnaround",
    "From “deal in the door” to “a diligence view you'd defend at IC” typically takes:",
    "Diligence turnaround",
    TURNAROUND,
    1
  ),
  scale("q_challenge", "“Our diligence holds up when the IC or co-investors challenge the assumptions.”", "Diligence holds up when challenged", AGREE, 1),
  scale("q_rerun", "“If a key assumption changes, we can re-run the full analysis the same day.”", "Can re-run same day", AGREE, 1),
  scale("q_sourced", "“Our probability-of-success estimates are well-sourced rather than pattern-matching.”", "PTRS well-sourced", AGREE, 1),
  scale("q_skip_freq", "“We pass or invest without analyses we'd have wanted.”", "Analyses skipped", { min: "Almost never", max: "Constantly" }, 1),
  multi(
    "q_skipped",
    "Which analyses most often get skipped?",
    "What gets skipped",
    ["Indication sequencing upside", "Trial design risk analysis", "Competitive scenario modeling", "Follow-on / reserve scenario planning", "Independent PTRS validation", "None"],
    1
  ),
  scale("q_disagree", "“Partner disagreement over assumptions delays decisions more than missing data.”", "Assumption disagreement delays", AGREE, 1),
  scale("q_use", "“I would have actually used a tool like this in a recent deal.”", "Would use", { min: "Definitely not", max: "Definitely yes" }, 2),
  multi(
    "q_plugin",
    "Where would it plug in?",
    "Where it plugs in",
    ["Screening", "Deep diligence", "IC memo prep", "Live what-ifs in IC discussion", "Post-investment monitoring", "It wouldn't"],
    2
  ),
  multi("q_trust", "What would it need before you'd put its number in an IC memo?", "Trust requirements", TRUST_CORE, 2),
  scale("q_build", "“My fund would sooner build something sufficient internally (analysts, data team) than buy it.”", "Build vs. buy lean", AGREE, 2),
  pick("q_price", "What annual price would feel like an easy yes?", "Price anchor", PRICE_CHOICES, 2),
  multi(
    "q_pain",
    "Who feels this pain most?",
    "Who feels the pain",
    ["Partners", "Principals / associates", "Platform / operating team", "Portfolio company boards", "LPs / co-investors"],
    2
  ),
  openEnd("Open comments"),
];

// ─── Hedge fund / public equities (Valuation only) ────────────────────────────
const HEDGE_FUND_QUESTIONS: SurveyQuestion[] = [
  ...aboutYou(
    "Your role",
    ["Portfolio manager", "Senior analyst", "Analyst", "Data / quant team", "Other"],
    ["Multi-manager platform", "Biotech specialist fund", "Generalist fund with a healthcare book", "Family office", "Other"]
  ),
  multi(
    "q_decisions",
    "Which of these position decisions does your team face?",
    "Decision types faced",
    ["Initiating a long", "Short thesis", "Catalyst positioning / sizing", "Exit timing", "Pair / relative-value trades", "Other"],
    1
  ),
  scale(
    "q_freq",
    "How often does a position decision hinge on a pipeline asset's probability-adjusted value?",
    "Decision frequency",
    { min: "Rarely (≤1 / year)", max: "Constantly (weekly)" },
    1
  ),
  steps(
    "q_turnaround",
    "From “idea” to “a thesis you'd size a position on” typically takes:",
    "Thesis turnaround",
    ["Hours", "Days", "1–2 weeks", "~1 month", "1+ months"],
    1
  ),
  scale("q_challenge", "“Our pipeline models hold up when the PM or risk challenges them.”", "Models hold up when challenged", AGREE, 1),
  scale("q_rerun", "“When new data drops — a readout, a competitor event — we can re-run the valuation the same day.”", "Can re-run same day", AGREE, 1),
  scale("q_sourced", "“Our probability adjustments are well-sourced rather than gut.”", "PTRS well-sourced", AGREE, 1),
  scale("q_skip_freq", "“We take positions without analyses we'd have wanted.”", "Analyses skipped", { min: "Almost never", max: "Constantly" }, 1),
  multi(
    "q_skipped",
    "Which analyses most often get skipped?",
    "What gets skipped",
    ["Full probability-adjusted NPV per asset", "Catalyst scenario trees", "Competitive pipeline modeling", "Indication expansion upside", "Cross-checking sell-side numbers", "None"],
    1
  ),
  scale("q_disagree", "“Team disagreement over assumptions costs us more than missing data.”", "Assumption disagreement costs", AGREE, 1),
  scale("q_use", "“I would have actually used a tool like this in a recent thesis.”", "Would use", { min: "Definitely not", max: "Definitely yes" }, 2),
  multi(
    "q_plugin",
    "Where would it plug in?",
    "Where it plugs in",
    ["Idea screening", "Thesis build", "Catalyst prep", "Position sizing", "Live monitoring / updates", "It wouldn't"],
    2
  ),
  multi(
    "q_trust",
    "What would it need before you'd trust its number in a live position?",
    "Trust requirements",
    [
      "Match our internal models on names we know",
      "Full source traceability for every number",
      "Published calibration / backtest track record",
      "Clear speed advantage over sell-side",
      "Compliance / data-security sign-off",
      "Nothing would get it there",
    ],
    2
  ),
  scale("q_build", "“My fund would sooner build something sufficient internally than pay for an external tool.”", "Build vs. buy lean", AGREE, 2),
  pick("q_price", "What annual price (per seat or team) would feel like an easy yes?", "Price anchor", PRICE_CHOICES, 2),
  multi(
    "q_pain",
    "Who feels this pain most?",
    "Who feels the pain",
    ["Portfolio managers", "Analysts", "Data / quant team", "Risk", "Execution / trading"],
    2
  ),
  openEnd("Open comments"),
];

// ─── University tech transfer office (Strategic Advisor) ─────────────────────
const TECH_TRANSFER_QUESTIONS: SurveyQuestion[] = [
  ...aboutYou(
    "Your functional area",
    ["Licensing officer", "Tech transfer leadership", "Business development", "New ventures / spinouts", "Other"],
    ["Large research university (top-25 research spend)", "Mid-size university", "Research institute / hospital system", "Other"]
  ),
  multi(
    "q_decisions",
    "Which of these asset decisions does your office face?",
    "Decision types faced",
    ["Licensing negotiations", "Spinout formation", "Patent / maintenance prioritization", "Indication or market positioning", "Seeking translational funding", "Other"],
    1
  ),
  scale(
    "q_freq",
    "How often do you need a defensible value estimate for an early-stage asset?",
    "Valuation-need frequency",
    { min: "Rarely (≤1 / year)", max: "Constantly (weekly)" },
    1
  ),
  steps(
    "q_turnaround",
    "From “asset disclosed” to “a valuation or strategy you'd defend to a licensee or committee” typically takes:",
    "Valuation turnaround",
    TURNAROUND,
    1
  ),
  scale("q_challenge", "“Our valuations hold up when licensees, investors, or faculty challenge them.”", "Valuation holds up when challenged", AGREE, 1),
  scale("q_rerun", "“When terms or data change, we can re-run the analysis quickly.”", "Can re-run quickly", AGREE, 1),
  scale("q_sourced", "“Our probability-of-success assumptions are well-sourced rather than rules of thumb.”", "PTRS well-sourced", AGREE, 1),
  scale("q_skip_freq", "“We negotiate or prioritize without analyses we'd have wanted.”", "Analyses skipped", { min: "Almost never", max: "Constantly" }, 1),
  multi(
    "q_skipped",
    "Which analyses most often get skipped?",
    "What gets skipped",
    ["Indication / market positioning comparisons", "Development-path-to-value modeling", "License vs. spinout comparisons", "Probability-adjusted valuation per asset", "Comparable deal benchmarks", "None"],
    1
  ),
  scale("q_disagree", "“Disagreement over assumptions — with faculty, licensees, or leadership — is our biggest source of friction.”", "Assumption disagreement friction", AGREE, 1),
  scale("q_use", "“I would have actually used a tool like this in a recent licensing or spinout decision.”", "Would use", { min: "Definitely not", max: "Definitely yes" }, 2),
  multi(
    "q_plugin",
    "Where would it plug in?",
    "Where it plugs in",
    ["Triage of new disclosures", "Valuation for negotiations", "Development-path strategy", "Board / committee materials", "Supporting spinout fundraising", "It wouldn't"],
    2
  ),
  multi(
    "q_trust",
    "What would it need before you'd rely on its number in a negotiation?",
    "Trust requirements",
    [
      "Match comparable deal benchmarks we know",
      "Full source traceability for every number",
      "Published calibration / validation track record",
      "Adoption by peer tech transfer offices",
      "Low cost / easy budget justification",
      "Nothing would get it there",
    ],
    2
  ),
  scale("q_build", "“My office would sooner keep doing this internally (or with consultants) than buy a tool.”", "Build vs. buy lean", AGREE, 2),
  pick("q_price", "What annual price would feel like an easy budget approval?", "Price anchor", PRICE_CHOICES, 2),
  multi(
    "q_pain",
    "Who feels this pain most?",
    "Who feels the pain",
    ["Licensing officers", "Tech transfer leadership", "New ventures team", "University finance", "Faculty founders"],
    2
  ),
  openEnd("Open comments"),
];

export const QUESTIONS_BY_SEGMENT: Record<SegmentId, SurveyQuestion[]> = {
  biopharma: BIOPHARMA_QUESTIONS,
  biopharma_ma_bd: BIOPHARMA_MA_BD_QUESTIONS,
  vc_pe: VC_PE_QUESTIONS,
  hedge_fund: HEDGE_FUND_QUESTIONS,
  tech_transfer: TECH_TRANSFER_QUESTIONS,
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
  tech_transfer: [
    "It's an AI platform that builds a defensible, sourced valuation for early-stage assets — from discovery and preclinical onward — with AI-driven probability calculations, and lets you compare the strategic options behind each asset: which indication to position, license vs. spin out, which development path reaches a value inflection — with the reasoning shown and traceable, not a black box.",
    "You could add and compare scenarios instantly — before a negotiation or a committee meeting — simply by asking in plain language.",
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function isSegmentId(v: unknown): v is SegmentId {
  return v === "biopharma" || v === "biopharma_ma_bd" || v === "vc_pe" || v === "hedge_fund" || v === "tech_transfer";
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
