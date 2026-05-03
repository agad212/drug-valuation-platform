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
