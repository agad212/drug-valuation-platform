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
  bullM: number;
  bearM: number;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  analystEstimates: RevenueAnalystEstimate[];
  marketContext: RevenueMarketContext;
  comps: RevenueComp[];
  sources: Source[];
};

export type RevenueAnalysisResult = {
  drug: string;
  phase: string;
  indications: IndicationRevenueAnalysis[];
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
