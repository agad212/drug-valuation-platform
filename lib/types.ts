export type Money = number;

export type Source = { label: string; url?: string };

export type Indication = {
  id: string;
  name: string;
  peakSales?: Money;
  launchYear?: number;
  loeYear?: number;
  phase?: string;
  ptrs?: number;      // per-indication override; falls back to parent drug PTRS
  devCostPV?: Money;  // per-indication dev cost; if unset, global devCostPV is split evenly
  // Multi-indication structure (Layer-2-populated or user-set; the deterministic aggregation in
  // computeOutputs consumes it). Lead (first) indication is always independent. Others:
  //   "independent" (default; a SURFACED assumption) | "sequential-after:<id>" (launches ≥ the
  //   prerequisite) | "conditional-on:<id>" (contribution P-weighted by P(prerequisite success)).
  // Unstated → assumed independent + flagged. Mechanism read-through into the prior is a later pass.
  indicationRelationship?: string;
  // Bottom-up market context (from revenue-assumptions) — persisted so the Strategy
  // Advisor can RE-DERIVE the market per scenario (Build 1/1b), not haircut the peak.
  tamM?: number;            // addressable market $M (eligible patients × annual WAC)
  penetrationPct?: number;  // peak penetration % (peakSales ≈ tamM × penetrationPct/100)
  annualPriceUsd?: number;  // annual WAC $/patient/yr — the base eligible COUNT = tamM/price
  // Module 3: the STATED eligible-patient count from the revenue elicitation. When present it
  // BEATS the tamM/price back-solve as the eligible pool (the back-solve assumes the very
  // identity the coherence check audits); back-solve remains the fallback.
  eligiblePatients?: number;
  // Module 3: the revenue module's ELICITED p05/p95 peak-sales bounds ($M), persisted when the
  // estimate is applied — the scenario branches read these as true Pearson-Tukey outer values
  // instead of the ×0.7/×1.3 placeholders.
  bearPeakM?: number;
  bullPeakM?: number;
  // 4.6 — development-activity status (LLM-emitted OBSERVABLE, citation-gated). A stalled or
  // discontinued program contributing to the headline is surfaced as a flag naming its share — the
  // value is NOT adjusted (a "reactivation probability" would be an invented constant; the flag lets
  // the human judge). "active" or absent → no flag.
  developmentStatus?: "active" | "stalled" | "discontinued";
  developmentStatusBasis?: string;  // the citation (trade press / CT.gov status / sponsor pipeline page)
  nctId?: string;
  sources?: Source[];
};

export type RevenueAnalystEstimate = {
  source: string;
  url?: string;
  estimateM: number;
  year?: number;
  quote: string;
};

export type RevenueMarketContext = {
  tamM?: number;
  penetrationPct?: number;
  patientPopDesc?: string;
  pricingPerYear?: number;
  competitive?: string;
  // Module 3 elicitation: the STRUCTURED eligible-patient count (drug-eligible, treated pool).
  // Makes the TAM arithmetic verifiable: tamM ≈ eligiblePatients × pricingPerYear. The 8/8 live
  // run's $3B-TAM-vs-$12B-patient-math contradiction was only catchable with this field.
  eligiblePatients?: number;
};

export type RevenueComp = {
  drug: string;
  indication: string;
  peakSalesM: number;
  rationale: string;
};

export type IndicationRevenueAnalysis = {
  indication: string;
  peakSalesM: number;
  bullM: number;   // elicited p95 (extremes-first; NOT a ±% template)
  bearM: number;   // elicited p05
  confidence: "high" | "medium" | "low";
  reasoning: string;
  analystEstimates: RevenueAnalystEstimate[];
  marketContext: RevenueMarketContext;
  comps: RevenueComp[];
  sources: Source[];
  // Module 3: deterministic coherence findings (TAM vs patients×price; peak vs TAM×penetration;
  // bear<base<bull ordering; suspiciously narrow p05–p95 spread). Display-only, engine-untouched.
  coherenceFlags?: string[];
};

export type RevenueAnalysisResult = {
  drug: string;
  phase: string;
  indications: IndicationRevenueAnalysis[];
  // Module 3: the facilitator checker's rationale audit (gated, display-only prose). flags =
  // the gate's drop/truncate diagnostics — rendered faintly so a rejected response is never
  // indistinguishable from a clean one.
  elicitationReview?: { findings: { severity: "high" | "medium" | "info"; message: string }[]; flags: string[] };
};

export type Valuation = {
  id?: string;
  slug?: string;
  name?: string;
  asset?: string;
  indication?: string;
  mechanism?: string;
  sponsor?: string;
  ownerType?: "Owner" | "Licensor";
  peakSales?: Money;
  discountRate?: number;
  cogsPct?: number;
  taxRate?: number;
  workingCapitalPct?: number;
  avgRoyalty?: number;
  distributionPct?: number;
  commercialOpexPct?: number;
  launchYear?: number;
  loeYear?: number;
  // How loeYear was derived: "patent" = calendar-fixed patent expiry;
  // "exclusivity" = regulatory exclusivity anchored to launch/approval.
  // Undefined = manually entered (never auto-shifted unless launch overtakes it).
  loeBasis?: "patent" | "exclusivity";
  loeExclusivityYears?: number; // regulatory exclusivity term (12 biologic, 8 small molecule)
  phase?: string;
  ptrs?: number;
  devCostPV?: Money;
  revenuePV?: Money;
  rnpv?: Money;
  roi?: number;
  sources?: Source[];
  indications?: Indication[];
  createdAt?: string;
  updatedAt?: string;
  [k: string]: any;
};
