export type CtgovTrial = {
  nctId: string;
  title?: string;
  phase?: string;               // App format: "Phase 1", "Phase 2", "Phase 3"
  phaseRaw?: string;            // Display: "Phase 2/Phase 3"
  status?: string;              // CT.gov raw status code
  statusLabel?: string;         // Human-readable
  startDate?: string;
  primaryCompletionDate?: string;
  completionDate?: string;
  conditions?: string[];
  sponsor?: string;
  estimatedLaunchYear?: number;
  claudeReason?: string;        // Why Claude flagged this as relevant
  sources: { label: string; url: string }[];
};

// ─── Phase mapping ─────────────────────────────────────────────────────────────

const PHASE_MAP: Record<string, string> = {
  EARLY_PHASE1: "Phase 1",
  PHASE1:       "Phase 1",
  PHASE2:       "Phase 2",
  PHASE3:       "Phase 3",
  PHASE4:       "Phase 4",
  NA:           "",
};

function mapPhases(phases: string[] | undefined): { phase: string; phaseRaw: string } {
  if (!phases || phases.length === 0) return { phase: "", phaseRaw: "" };
  const mapped = phases.map((p) => PHASE_MAP[p] || "").filter(Boolean);
  if (mapped.length === 0) return { phase: "", phaseRaw: "" };
  const phaseRaw = mapped.join("/");
  // Use the highest phase for sorting — Phase 2/3 combo sorts as Phase 3
  if (mapped.includes("Phase 4")) return { phase: "Phase 4", phaseRaw };
  if (mapped.includes("Phase 3")) return { phase: "Phase 3", phaseRaw };
  if (mapped.includes("Phase 2")) return { phase: "Phase 2", phaseRaw };
  if (mapped.includes("Phase 1")) return { phase: "Phase 1", phaseRaw };
  return { phase: mapped[0], phaseRaw };
}

// ─── Status labels ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  RECRUITING:               "Recruiting",
  ACTIVE_NOT_RECRUITING:    "Active, not recruiting",
  COMPLETED:                "Completed",
  NOT_YET_RECRUITING:       "Not yet recruiting",
  ENROLLING_BY_INVITATION:  "Enrolling by invitation",
  TERMINATED:               "Terminated",
  WITHDRAWN:                "Withdrawn",
  SUSPENDED:                "Suspended",
  UNKNOWN:                  "Unknown",
};

// ─── Launch year estimation ────────────────────────────────────────────────────

function estimateLaunchYear(
  phase: string,
  primaryCompletion?: string,
  completion?: string,
  status?: string
): number | undefined {
  // Prefer primaryCompletionDate (efficacy readout) over completionDate (long-term follow-up)
  const dateStr = primaryCompletion || completion;
  if (!dateStr) return undefined;
  const endYear = parseInt(dateStr.slice(0, 4), 10);
  if (isNaN(endYear)) return undefined;
  const now = new Date().getFullYear();
  // Years from primary endpoint readout to market launch:
  //   Phase 3 completed: ~1 yr (FDA review only)
  //   Phase 3 active/recruiting: ~2 yr
  //   Phase 2: ~4 yr (pivotal Phase 3 + FDA review)
  //   Phase 1: ~7 yr (Phase 2 + Phase 3 + FDA review)
  const isCompleted = status === "COMPLETED";
  const buffers: Record<string, number> = {
    "Phase 3": isCompleted ? 1 : 2,
    "Phase 2": 4,
    "Phase 1": 7,
  };
  const rawEstimate = endYear + (buffers[phase] ?? 4);
  // If the estimated launch is in the past, return undefined — indication likely already launched
  if (rawEstimate <= now) return undefined;
  // Cap at current year + 15 to prevent absurd values from long follow-up dates
  return Math.min(rawEstimate, now + 15);
}

// ─── Experimental arm filter ───────────────────────────────────────────────────
// Returns true if the drug appears as an EXPERIMENTAL intervention in this study.
// If arm data is missing or ambiguous, returns true (include by default).

function isExperimentalIntervention(study: any, drugName: string): boolean {
  const arms = study.protocolSection?.armsInterventionsModule;
  if (!arms) return true;

  const armGroups: any[] = arms.armGroups || [];
  const interventions: any[] = arms.interventions || [];

  // Find labels of EXPERIMENTAL arms
  const experimentalLabels = new Set(
    armGroups.filter((a) => a.type === "EXPERIMENTAL").map((a) => a.label as string)
  );
  if (experimentalLabels.size === 0) return true; // no experimental arms defined → include

  const drugLower = drugName.toLowerCase();

  // Check if any intervention matches the drug AND belongs to an experimental arm
  return interventions.some((intvn) => {
    const name: string = (intvn.name || "").toLowerCase();
    // Fuzzy name match — drug name contains intervention name or vice versa
    const nameMatch = name.includes(drugLower) || drugLower.includes(name.split(" ")[0]);
    if (!nameMatch) return false;
    return (intvn.armGroupLabels || []).some((label: string) => experimentalLabels.has(label));
  });
}

// ─── Parse a single CT.gov v2 study object ────────────────────────────────────

function parseStudy(s: any): CtgovTrial | null {
  const p = s?.protocolSection;
  if (!p) return null;

  const nctId = p.identificationModule?.nctId;
  if (!nctId) return null;

  const title =
    p.identificationModule?.officialTitle ||
    p.identificationModule?.briefTitle;

  const phasesRaw: string[] = p.designModule?.phases || [];
  const { phase, phaseRaw } = mapPhases(phasesRaw);

  const status: string = p.statusModule?.overallStatus || "";
  const statusLabel = STATUS_LABELS[status] || status;

  const startDate = p.statusModule?.startDateStruct?.date;
  const primaryCompletionDate = p.statusModule?.primaryCompletionDateStruct?.date;
  const completionDate = p.statusModule?.completionDateStruct?.date;

  const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name;
  const conditions: string[] = p.conditionsModule?.conditions || [];

  const estimatedLaunchYear = phase
    ? estimateLaunchYear(phase, primaryCompletionDate, completionDate, status)
    : undefined;

  return {
    nctId,
    title,
    phase: phase || undefined,
    phaseRaw: phaseRaw || phase || undefined,
    status,
    statusLabel,
    startDate,
    primaryCompletionDate,
    completionDate,
    conditions,
    sponsor,
    estimatedLaunchYear,
    sources: [
      { label: `ClinicalTrials.gov — ${nctId}`, url: `https://clinicaltrials.gov/study/${nctId}` },
    ],
  };
}

// ─── Fetch a single trial by NCT ID ───────────────────────────────────────────

export async function fetchCtgov(nctId: string): Promise<CtgovTrial | null> {
  const id = (nctId || "").trim();
  if (!id) return null;
  const url = `https://clinicaltrials.gov/api/v2/studies/${encodeURIComponent(id)}?format=json`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return parseStudy(await res.json());
  } catch {
    return null;
  }
}

// ─── Search + filter trials by drug name ──────────────────────────────────────

export async function searchTrialsByDrug(
  drugName: string,
  options: { isApproved?: boolean } = {}
): Promise<CtgovTrial[]> {
  // For approved drugs, limit to Phase 2/3 (post-marketing & label expansion).
  // For pipeline drugs, include all phases.
  const statusFilter = "RECRUITING,ACTIVE_NOT_RECRUITING,COMPLETED,NOT_YET_RECRUITING";
  const params = new URLSearchParams({
    "query.intr": drugName,
    "filter.overallStatus": statusFilter,
    "format": "json",
    "pageSize": "200",
  });

  const url = `https://clinicaltrials.gov/api/v2/studies?${params}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const json = await res.json();
    const studies: any[] = json?.studies || [];

    // Step 1: Filter to experimental arm only
    const experimental = studies.filter((s) => isExperimentalIntervention(s, drugName));

    // Step 2: For approved drugs, also filter to Phase 2/3
    const phaseFiltered = options.isApproved
      ? experimental.filter((s) => {
          const phases: string[] = s.protocolSection?.designModule?.phases || [];
          return phases.some((p) => p === "PHASE2" || p === "PHASE3");
        })
      : experimental;

    // Step 3: Parse
    const trials = phaseFiltered.map(parseStudy).filter((t): t is CtgovTrial => t !== null);

    // Step 4: Sort Phase 3 → Phase 2 → Phase 1, then Completed → Active → Recruiting
    const phaseOrder: Record<string, number> = { "Phase 3": 0, "Phase 2": 1, "Phase 1": 2, "Phase 4": 3 };
    const statusOrder: Record<string, number> = {
      COMPLETED: 0, ACTIVE_NOT_RECRUITING: 1, RECRUITING: 2, NOT_YET_RECRUITING: 3,
    };
    return trials.sort((a, b) => {
      const pa = phaseOrder[a.phase || ""] ?? 4;
      const pb = phaseOrder[b.phase || ""] ?? 4;
      if (pa !== pb) return pa - pb;
      return (statusOrder[a.status || ""] ?? 4) - (statusOrder[b.status || ""] ?? 4);
    });
  } catch {
    return [];
  }
}
