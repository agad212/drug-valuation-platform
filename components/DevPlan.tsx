// ─── Dev Plan Component ────────────────────────────────────────────────────────
//
// Renders the stage-by-stage development path inline in the main valuation.
// All state (stageInputs, devPlan, loading) is owned by the parent (index.tsx)
// and auto-generated after Layer 2 completes.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from "react";
import { type DevStageInput, type DevPlanResult, type DevStage } from "../lib/dev-plan";
import type { RegulatoryContext } from "../lib/ptrs-trial";

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  stageInputs: DevStageInput[] | null;
  regContext: RegulatoryContext;
  devPlan: DevPlanResult | null;
  reasoning: string | null;
  loading: boolean;
  onUpdateN: (id: string, n: number) => void;
  onUpdateCpp: (id: string, cpp: number) => void;
};

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtM(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  if (abs >= 1)    return `$${n.toFixed(1)}M`;
  return `~$0`;
}
function fmtPct(n?: number | null, dp = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(dp)}%`;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function probColor(p: number): string {
  if (p >= 0.70) return "#10b981";
  if (p >= 0.50) return "#3b82f6";
  if (p >= 0.35) return "#f59e0b";
  return "#ef4444";
}
function mssColor(m: number): string {
  if (m >= 0.75) return "#10b981";
  if (m >= 0.55) return "#3b82f6";
  return "#f59e0b";
}

// ─── Inline number editor ─────────────────────────────────────────────────────

function InlineNumber({
  value, onChange, prefix = "", suffix = "", min = 1,
}: {
  value: number; onChange: (v: number) => void;
  prefix?: string; suffix?: string; min?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState(String(value));

  function commit() {
    const n = Number(txt);
    if (!Number.isNaN(n) && n >= min) onChange(n);
    else setTxt(String(value));
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number" min={min}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setTxt(String(value)); setEditing(false); } }}
        style={{
          width: 80, fontSize: 12, padding: "2px 6px", fontFamily: "var(--font-mono)",
          background: "var(--surface-2)", border: "1px solid var(--accent)",
          borderRadius: 4, color: "var(--text)", outline: "none",
        }}
      />
    );
  }

  return (
    <span
      onClick={() => { setTxt(String(value)); setEditing(true); }}
      title="Click to edit"
      style={{
        cursor: "text", textDecoration: "underline dotted", textUnderlineOffset: 3,
        fontFamily: "var(--font-mono)", fontSize: 12,
      }}
    >
      {prefix}{typeof value === "number" && value >= 1000 ? Math.round(value).toLocaleString() : value}{suffix}
    </span>
  );
}

// ─── Stage Card ───────────────────────────────────────────────────────────────

function StageCard({
  stage, index, totalStages, onUpdateN, onUpdateCpp,
}: {
  stage: DevStage;
  index: number;
  totalStages: number;
  onUpdateN: (id: string, n: number) => void;
  onUpdateCpp: (id: string, cpp: number) => void;
}) {
  const color = stage.isCurrentTrial ? "#10b981" : "#3b82f6";
  const probC = probColor(stage.trialSuccessProb);

  return (
    <div style={{ display: "flex", gap: 0 }}>
      {/* Left timeline */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0 }}>
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          background: color, border: `2px solid ${color}`,
          flexShrink: 0, marginTop: 16,
        }} />
        {index < totalStages - 1 && (
          <div style={{ width: 2, flex: 1, background: "var(--border)", marginTop: 4 }} />
        )}
      </div>

      {/* Card content */}
      <div style={{
        flex: 1, border: `1px solid ${color}40`, borderRadius: 10,
        background: "var(--surface)", marginBottom: 12, overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          background: `${color}12`, borderBottom: `1px solid ${color}25`,
          padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: color, color: "#fff" }}>
                {stage.phase}
              </span>
              {stage.isCurrentTrial && (
                <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(16,185,129,0.15)", color: "#10b981" }}>
                  CURRENT TRIAL
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>
              {stage.name}
            </div>
            {stage.aiRationale && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2, fontStyle: "italic" }}>
                {stage.aiRationale}
              </div>
            )}
          </div>

          {/* P(trial success) badge */}
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>P(trial success)</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: probC, fontFamily: "var(--font-display)", lineHeight: 1 }}>
              {fmtPct(stage.trialSuccessProb)}
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "12px 14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 14, marginBottom: 14 }}>

            {/* Enrollment + CPP */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Enrollment
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                n = <InlineNumber
                  value={stage.n}
                  onChange={(v) => onUpdateN(stage.id, v)}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                {stage.trialDesign.designType.replace("_", " ")} · {stage.trialDesign.endpointType} endpoint
              </div>
            </div>

            {/* CPP and trial cost */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Cost / patient
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                <InlineNumber
                  value={stage.cpp}
                  onChange={(v) => onUpdateCpp(stage.id, v)}
                  prefix="$"
                  min={1000}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                Trial cost: {fmtM(stage.trialCostM)}
              </div>
            </div>

            {/* Risk-adjusted cost */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Risk-adj cost
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {fmtM(stage.riskAdjCostM)}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                {stage.isCurrentTrial
                  ? "Full cost (current trial)"
                  : `${fmtM(stage.trialCostM)} × ${fmtPct(stage.pPriorSuccess)} prior`}
              </div>
            </div>

            {/* Regulatory context */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Designation
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {stage.trialDesign.regulatoryContext.replace("_", " + ").toUpperCase()}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                {stage.trialDesign.populationType.replace("_", " ")}
              </div>
            </div>
          </div>

          {/* Drug truth state */}
          <div style={{
            background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px",
            display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 2 }}>Drug truth entering</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: mssColor(stage.mssInput), fontFamily: "var(--font-mono)" }}>
                MSS {(stage.mssInput * 100).toFixed(0)}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
                σ² {stage.varianceInput.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 4 }}>if positive →</div>
              <div style={{ fontSize: 18, color: "var(--text-faint)" }}>→</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 2 }}>Drug truth updated</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: mssColor(stage.mssIfSuccess), fontFamily: "var(--font-mono)" }}>
                MSS {(stage.mssIfSuccess * 100).toFixed(0)}
                <span style={{ fontSize: 11, color: "#10b981", marginLeft: 4 }}>
                  +{((stage.mssIfSuccess - stage.mssInput) * 100).toFixed(0)}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
                σ² {stage.varianceIfSuccess.toFixed(2)} · ptrsL1 {fmtPct(stage.ptrsLayer1Input)}
              </div>
            </div>
          </div>

          {/* Cumulative probability */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Cumulative P(success through this stage):
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: probColor(stage.cumSuccessProb), fontFamily: "var(--font-mono)" }}>
              {fmtPct(stage.cumSuccessProb)}
            </div>
            {!stage.isCurrentTrial && (
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                ({fmtPct(stage.pPriorSuccess)} × {fmtPct(stage.trialSuccessProb)})
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Reg Stage Card ────────────────────────────────────────────────────────────

function RegCard({ regStage }: { regStage: DevPlanResult["regStage"] }) {
  return (
    <div style={{ display: "flex", gap: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0 }}>
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "#7c3aed", border: "2px solid #7c3aed",
          flexShrink: 0, marginTop: 16,
        }} />
      </div>
      <div style={{
        flex: 1, border: "1px solid #7c3aed40", borderRadius: 10,
        background: "var(--surface)", marginBottom: 12, overflow: "hidden",
      }}>
        <div style={{
          background: "#7c3aed12", borderBottom: "1px solid #7c3aed25",
          padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#7c3aed", color: "#fff", marginRight: 8 }}>
              REG FILING
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>
              Regulatory Submission &amp; Approval
            </span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>P(approval | filing)</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: probColor(regStage.pApproval), fontFamily: "var(--font-display)", lineHeight: 1 }}>
              {fmtPct(regStage.pApproval)}
            </div>
          </div>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Nominal cost</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{fmtM(regStage.costM)}</div>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>NDA/MAA preparation + filing</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Risk-adj cost</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{fmtM(regStage.riskAdjCostM)}</div>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
              {fmtM(regStage.costM)} × {fmtPct(regStage.pPriorSuccess)} trials success
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Designation</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
              {regStage.regulatoryContext.replace("_", " + ").toUpperCase()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Summary Banner ────────────────────────────────────────────────────────────

function SummaryBanner({ plan }: { plan: DevPlanResult }) {
  return (
    <div style={{
      background: "linear-gradient(135deg, #1e1b4b, #312e81)",
      borderRadius: 12, padding: "18px 20px",
    }}>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
        Development Plan Summary — Expected Value
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginBottom: 3 }}>P(approval)</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: probColor(plan.pApproval), fontFamily: "var(--font-display)", lineHeight: 1 }}>
            {fmtPct(plan.pApproval)}
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
            {fmtPct(plan.pAllTrialsSuccess)} trials × {fmtPct(plan.regStage.pApproval)} reg
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginBottom: 3 }}>Expected R&D cost</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f97316", fontFamily: "var(--font-mono)", lineHeight: 1 }}>
            {fmtM(plan.totalRiskAdjCostM)}
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
            nominal {fmtM(plan.totalNominalCostM)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginBottom: 3 }}>eNPV</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "var(--font-display)", lineHeight: 1, color: plan.eNPVM >= 0 ? "#10b981" : "#ef4444" }}>
            {fmtM(plan.eNPVM)}
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
            {plan.eROI != null ? `${plan.eROI.toFixed(2)}x eROI` : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginBottom: 3 }}>Nominal total cost</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", lineHeight: 1, color: "#94a3b8" }}>
            {fmtM(plan.totalNominalCostM)}
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
            if all stages run (unrisked)
          </div>
        </div>
      </div>

      {/* Probability waterfall */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>Probability waterfall</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {plan.stages.map((s) => (
            <React.Fragment key={s.id}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2, fontFamily: "var(--font-mono)" }}>
                  {s.phase.replace("Phase ", "Ph")}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: probColor(s.trialSuccessProb) }}>
                  {fmtPct(s.trialSuccessProb, 0)}
                </div>
              </div>
              <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 16 }}>×</div>
            </React.Fragment>
          ))}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2, fontFamily: "var(--font-mono)" }}>Reg</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: probColor(plan.regStage.pApproval) }}>
              {fmtPct(plan.regStage.pApproval, 0)}
            </div>
          </div>
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 16 }}>=</div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2, fontFamily: "var(--font-mono)" }}>P(approval)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: probColor(plan.pApproval) }}>
              {fmtPct(plan.pApproval, 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Cost waterfall */}
      <div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>Risk-adjusted cost breakdown</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {plan.stages.map((s) => (
            <div key={s.id} style={{
              background: "rgba(255,255,255,0.08)", borderRadius: 6, padding: "5px 10px",
              fontSize: 11, fontFamily: "var(--font-mono)",
            }}>
              <span style={{ color: "rgba(255,255,255,0.5)" }}>
                {s.phase.replace("Phase ", "Ph")}:{" "}
              </span>
              <span style={{ color: "#f97316", fontWeight: 600 }}>{fmtM(s.riskAdjCostM)}</span>
              {s.isCurrentTrial && <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}> (full)</span>}
              {!s.isCurrentTrial && (
                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>
                  {" "}({fmtM(s.trialCostM)} × {fmtPct(s.pPriorSuccess, 0)})
                </span>
              )}
            </div>
          ))}
          <div style={{
            background: "rgba(255,255,255,0.08)", borderRadius: 6, padding: "5px 10px",
            fontSize: 11, fontFamily: "var(--font-mono)",
          }}>
            <span style={{ color: "rgba(255,255,255,0.5)" }}>Reg: </span>
            <span style={{ color: "#f97316", fontWeight: 600 }}>{fmtM(plan.regStage.riskAdjCostM)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DevPlan({ stageInputs, devPlan, reasoning, loading, onUpdateN, onUpdateCpp }: Props) {
  if (loading && !devPlan) {
    return (
      <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: 13 }}>
        ⏳ Generating development plan…
      </div>
    );
  }

  if (!devPlan || !stageInputs) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* AI reasoning */}
      {reasoning && (
        <div style={{
          background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)",
          borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "var(--text)", lineHeight: 1.7,
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>
            AI Development Path Reasoning
          </span>
          {reasoning}
        </div>
      )}

      {/* Stage timeline */}
      <div>
        {devPlan.stages.map((stage, i) => (
          <StageCard
            key={stage.id}
            stage={stage}
            index={i}
            totalStages={devPlan.stages.length}
            onUpdateN={onUpdateN}
            onUpdateCpp={onUpdateCpp}
          />
        ))}
        <RegCard regStage={devPlan.regStage} />
      </div>

      {/* Summary banner */}
      <SummaryBanner plan={devPlan} />

      {/* Methodology note */}
      <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.6, fontFamily: "var(--font-mono)" }}>
        P(trial success) = Layer 2 Φ(z) for each trial&apos;s specific design ·
        Drug truth update after success: MSS +10–15% (endpoint-dependent), σ² ×0.65 ·
        Risk-adj cost = trial cost × P(all prior stages succeeded) ·
        eNPV = P(approval) × Revenue PV − total risk-adj cost ·
        Costs cover trial execution only (CPP × n); main valuation dev cost includes CMC, overhead &amp; sunk program spend ·
        CPP values are editable — click any underlined number
      </div>
    </div>
  );
}
