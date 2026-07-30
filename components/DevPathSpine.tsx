// components/DevPathSpine.tsx
//
// RENDER-ONLY trial-box primitive for the development path. Reads devPlan.stages[i] (already computed by
// computeDevPlan) — phase, P(trial success), duration, risk-adjusted cost, N, cost/patient — laid out as
// boxes on a horizontal spine, with the cumulative P carried between boxes. Design-aware power surfaces
// here (a futility marker + sequential look ticks) BY READING the stage's already-computed designFlags /
// sequentialDesign — it re-computes nothing and sets no state.

import React from "react";
import type { DevPlanResult } from "../lib/dev-plan";

const fmtPct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const fmtM = (m: number | null | undefined) => (m == null ? "—" : m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);

function probColor(p: number): string {
  if (p >= 0.6) return "#10b981";
  if (p >= 0.35) return "#eab308";
  return "#f97316";
}

function StatCell({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div title={title} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)" }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{value}</div>
    </div>
  );
}

export default function DevPathSpine({ devPlan }: { devPlan: DevPlanResult }) {
  const stages = devPlan.stages ?? [];
  if (!stages.length) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        Development path · time · cost · probability
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 0, overflowX: "auto", paddingBottom: 6 }}>
        {stages.map((s, i) => {
          const pc = probColor(s.trialSuccessProb);
          const seq = s.sequentialDesign;
          const looks = seq?.zBoundaries?.length ?? 0;
          const hasFutility = !!(seq?.futilityZBoundaries?.length || seq?.futilityBinding);
          return (
            <React.Fragment key={s.id ?? i}>
              {/* Trial box */}
              <div style={{ flex: "0 0 auto", width: 172, border: `1px solid ${pc}55`, borderRadius: 10, background: "var(--surface)", overflow: "hidden" }}>
                <div style={{ background: `${pc}14`, borderBottom: `1px solid ${pc}30`, padding: "7px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: pc, color: "#fff" }}>{s.phase}</span>
                  {s.isCurrentTrial && <span style={{ fontSize: 8.5, fontWeight: 700, color: "#10b981", letterSpacing: "0.05em" }}>● LIVE</span>}
                </div>
                {/* Sequential look ticks + futility marker (render-only; from the computed design) */}
                {looks > 0 && (
                  <div title={`Group-sequential: ${looks} look(s)${seq?.expectedN ? ` · E[N] ≈ ${Math.round(seq.expectedN)}` : ""}${seq?.achievedTypeI != null ? ` · binding type-I ${(seq.achievedTypeI * 100).toFixed(2)}%` : ""}${hasFutility ? " · futility interim" : ""}`}
                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px 0", borderBottom: "1px dashed var(--border)" }}>
                    <span style={{ fontSize: 8.5, color: "var(--text-faint)" }}>looks</span>
                    <div style={{ position: "relative", flex: 1, height: 8 }}>
                      <div style={{ position: "absolute", top: 3, left: 0, right: 0, height: 2, background: "var(--border)" }} />
                      {Array.from({ length: looks }).map((_, k) => (
                        <div key={k} style={{ position: "absolute", top: 0, left: `${((k + 1) / looks) * 100 - 4}%`, width: 8, height: 8, borderRadius: "50%", background: hasFutility && k < looks - 1 ? "#f59e0b" : pc }} />
                      ))}
                    </div>
                    {hasFutility && <span style={{ fontSize: 8.5, color: "#f59e0b", fontWeight: 700 }}>ⓕ</span>}
                  </div>
                )}
                <div style={{ padding: "8px 10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 8px" }}>
                  <StatCell label="P(success)" value={<span style={{ color: pc }}>{fmtPct(s.trialSuccessProb)}</span>}
                    title={s.successCeilingBound != null ? `capped at base-rate ceiling ${fmtPct(s.successCeilingBound)} (raw ${fmtPct(s.trialSuccessProbRaw)})` : undefined} />
                  <StatCell label="Cum. P" value={fmtPct(s.cumSuccessProb)} title="P(all stages through this one succeed)" />
                  <StatCell label="Duration" value={`${Math.round(s.durationMonths)}mo`} />
                  <StatCell label="Risk-adj $" value={fmtM(s.riskAdjCostM)} title={`nominal ${fmtM((s as any).trialCostM)}`} />
                  <StatCell label="N" value={(s as any).n ?? "—"} />
                  <StatCell label="$/patient" value={(s as any).cpp != null ? `$${Math.round(((s as any).cpp) / 1000)}k` : "—"} />
                </div>
                {s.modalityHaircut != null && s.modalityHaircut < 1 && (
                  <div title="modality-class base-rate risk (blended over the class-graveyard probability)" style={{ fontSize: 8.5, color: "#f59e0b", padding: "0 10px 7px" }}>×{s.modalityHaircut.toFixed(2)} class risk</div>
                )}
              </div>
              {/* Connector carrying cumulative P */}
              {i < stages.length - 1 && (
                <div style={{ flex: "0 0 auto", width: 40, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: "100%", height: 2, background: "var(--border)" }} />
                  <div style={{ fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{fmtPct(s.cumSuccessProb)}</div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        {/* Regulatory node */}
        {devPlan.regStage && (
          <>
            <div style={{ flex: "0 0 auto", width: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: "100%", height: 2, background: "var(--border)" }} />
            </div>
            <div style={{ flex: "0 0 auto", width: 132, border: "1px solid #3b82f655", borderRadius: 10, background: "var(--surface)", overflow: "hidden" }}>
              <div style={{ background: "#3b82f614", borderBottom: "1px solid #3b82f630", padding: "7px 10px" }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "#3b82f6", color: "#fff" }}>REG</span>
              </div>
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                <StatCell label="P(approval)" value={<span style={{ color: "#3b82f6" }}>{fmtPct(devPlan.regStage.pApproval)}</span>} />
                <StatCell label="Risk-adj $" value={fmtM(devPlan.regStage.riskAdjCostM)} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
