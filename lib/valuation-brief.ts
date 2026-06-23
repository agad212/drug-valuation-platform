// ═══════════════════════════════════════════════════════════════════════════
// Valuation Brief — Lead Reasoner Output Types
// ═══════════════════════════════════════════════════════════════════════════
//
// The valuationBrief is the AUTHORITATIVE, BINDING input to all downstream
// modules. It represents the lead reasoner's strategic assessment of a drug
// asset — what the company is actually trying to do, which trial is the
// real efficacy gate, what indication to value, and what the drug must beat.
//
// Downstream modules (ptrs-score, effect-prior, dev-plan, decision-analysis)
// must use the brief's values rather than running independent selection.
// A downstream module may NOT silently select a different indication, trial,
// endpoint, comparator, or threshold.
//
// ═══════════════════════════════════════════════════════════════════════════

/** How confident the reasoner is in a particular assessment. */
export type ConfidenceLevel =
  | "CONFIRMED"         // publicly stated, verifiable
  | "STRONG_INFERENCE"  // multiple converging public signals
  | "WEAK_INFERENCE"    // single signal or indirect evidence
  | "SPECULATIVE";      // educated guess with thin basis

/** A field tagged with its confidence level and source. */
export type TaggedField<T> = {
  value: T;
  confidence: ConfidenceLevel;
  source: string;
};

/** The structured output of the lead reasoner. */
export type ValuationBrief = {
  // ── Drug identity ──
  drug: string;
  sponsor: string;

  // ── True stage and efficacy gate ──
  true_stage: TaggedField<string>;
  efficacy_gate_trial: {
    trial_id: string;
    trial_name: string;
    is_efficacy_gate: boolean;
    reason: string;
    confidence: ConfidenceLevel;
  };
  excluded_trials: {
    trial_id: string;
    trial_name?: string;
    reason_excluded: string;
  }[];

  // ── Base case framing ──
  base_case_indication: TaggedField<string>;
  base_case_endpoint: TaggedField<string>;
  comparator: TaggedField<string>;
  soc_response_rate: {
    value: number;       // 0-1 decimal
    source: string;      // citation for the SOC rate
    confidence: ConfidenceLevel;
  };

  // ── Development strategy ──
  development_sequence: TaggedField<string[]>;
  designation_assumptions: TaggedField<string>;
  confirmed_strategy: string[];   // things the company has publicly stated
  inferred_strategy: string[];    // things inferred from public signals

  // ── Expectation anchor (smoke detector, NOT a thermostat) ──
  expectation_anchor: {
    range_low: number;   // e.g. 0.10 for "10-25% expected P(approval)"
    range_high: number;  // e.g. 0.25
    reason: string;
  };

  // ── Risks and value drivers ──
  key_risks: string[];
  key_value_drivers: string[];

  // ── Overall assessment ──
  is_low_confidence: boolean;    // true if base case rests on WEAK_INFERENCE/SPECULATIVE
  low_confidence_reason?: string;

  // ── Metadata ──
  sources_consulted: string[];
};

/** Result of the expectation smoke-detector check. */
export type ExpectationAuditResult = {
  expected_range: [number, number];
  actual_p_approval: number;
  divergence: "none" | "mild" | "sharp";
  audit_findings: string[];      // what was re-examined
  corrections_made: string[];    // what inputs were fixed (if any)
  conclusion: string;            // plain-language summary
};
