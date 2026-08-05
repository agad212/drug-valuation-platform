// components/SharedValuationView.tsx
//
// READ-ONLY rich renderer for a shared valuation. Client-only (dynamic ssr:false from /share/[slug]) so
// the recharts-backed sections hydrate safely. It renders the SAME section components the main app uses —
// fed entirely from the persisted share snapshot (v + _compute + _derived), never re-running the LLM
// pipeline. The only recompute is the pure engine (computeOutputs) over the GOVERNED inputs the snapshot
// was built from (chartValuation), so every number reconciles to the headline the app showed.

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import type { Valuation } from "../lib/types";
import { computeOutputs } from "../lib/cashflow";
import StrategicAssessment from "./StrategicAssessment";
import EffectPriorChain from "./EffectPriorChain";
import DevPlan from "./DevPlan";
import ScenarioPanel from "./ScenarioPanel";
import DecisionAnalysis, { buildProgramOptionResult } from "./DecisionAnalysis";

// ValuationCharts pulls in recharts — keep it client-only like the main app does.
const ValuationCharts = dynamic(() => import("./ValuationCharts"), { ssr: false });

// The persisted pipeline state + computed dev-plan result the snapshot carries (see onShare).
type ShareSnapshot = Valuation & {
  _compute?: {
    devPlanStages?: any;
    devPlanRegContext?: any;
    devPlanReasoning?: string | null;
    effectPrior?: any;
    valuationBrief?: any;
    briefSummary?: string | null;
    expectationAudit?: any;
    ptrsResult?: any;
    layer2Result?: any;
    structureFlags?: any;
    decisionState?: { open?: boolean; options?: any[]; aiSummary?: string | null; aiInsight?: string | null; chatHistory?: any[] } | null;
  } | null;
  _derived?: { devPlan?: any } | null;
};

function fmtMoney(n?: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) > 0) return `~$0`;
  return `$${n.toLocaleString()}`;
}
function fmtPct(n?: number | null, dp = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  return (n * 100).toFixed(dp) + "%";
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--bg-card-solid)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24, boxShadow: "var(--shadow-md)" }}>
      {children}
    </div>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-faint)", marginBottom: 12 }}>
      {children}
    </div>
  );
}
function MetricCard({ label, value, accent, sub }: { label: string; value: React.ReactNode; accent?: boolean; sub?: string }) {
  return (
    <div style={{
      background: accent ? "var(--card-green)" : "var(--bg-card-solid)",
      border: `1px solid ${accent ? "transparent" : "var(--border)"}`,
      borderRadius: "var(--radius-lg)", padding: "16px 20px", boxShadow: "var(--shadow-md)",
    }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: accent ? "rgba(255,255,255,0.7)" : "var(--text-faint)", fontFamily: "var(--font-display)", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-display)", color: accent ? "#fff" : "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: accent ? "rgba(255,255,255,0.7)" : "var(--text-faint)", fontFamily: "var(--font-mono)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function SharedValuationView({ valuation }: { valuation: ShareSnapshot }) {
  const out = useMemo(() => computeOutputs(valuation), [valuation]);
  const c = valuation._compute ?? {};
  const devPlan = valuation._derived?.devPlan ?? null;
  const isMulti = (valuation.indications?.length ?? 0) > 1;
  const roi = valuation.roi;
  // Base valuation as "Option 1" for the read-only unified advisor list (pure mapping of `out`/devPlan).
  const programOption = useMemo(() => buildProgramOptionResult({ valuation, governedOut: out, devPlan, isMulti }), [valuation, out, devPlan, isMulti]);

  const assumptions: [string, React.ReactNode][] = [
    ["Phase", valuation.phase || "—"],
    ["Owner Type", valuation.ownerType || "—"],
    ["Peak Sales", valuation.peakSales != null ? fmtMoney(valuation.peakSales) : "—"],
    ["Discount Rate", fmtPct(valuation.discountRate)],
    ["Launch Year", valuation.launchYear ?? "—"],
    ["LOE Year", valuation.loeYear ?? "—"],
    ["COGS %", fmtPct(valuation.cogsPct)],
    ["Tax Rate", fmtPct(valuation.taxRate)],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Headline metrics — the GOVERNED numbers (persisted scalars) */}
      <div className="metrics-grid">
        <MetricCard label="eNPV" value={fmtMoney(valuation.rnpv)} accent sub={isMulti ? "Σ per-indication (structural)" : undefined} />
        <MetricCard label="P(Approval)" value={fmtPct(valuation.ptrs, 0)} />
        <MetricCard label="Revenue PV" value={fmtMoney(valuation.revenuePV)} sub="before probability" />
        <MetricCard label="Dev Cost" value={fmtMoney(valuation.devCostPV)} sub="expected R&D" />
        <MetricCard label="eROI" value={roi != null ? roi.toFixed(1) + "x" : "—"} sub="eNPV / dev cost" />
      </div>

      {/* Key assumptions */}
      <Card>
        <SectionLabel>Key Assumptions</SectionLabel>
        <div className="form-grid-4">
          {assumptions.map(([k, val]) => (
            <div key={String(k)}>
              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "var(--font-mono)" }}>{k}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{val}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Indications breakdown (multi-indication) */}
      {isMulti && out.indicationOutputs.length > 0 && (
        <Card>
          <SectionLabel>Indications</SectionLabel>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: "var(--text-faint)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>Indication</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>Peak ($M)</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>Launch</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>LOE</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>P(appr.)</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>Rev PV</th>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>rNPV</th>
                </tr>
              </thead>
              <tbody>
                {out.indicationOutputs.map((o, i) => (
                  <tr key={o.id ?? i} style={{ borderTop: "1px solid var(--border)", textAlign: "right", color: "var(--text)" }}>
                    <td style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>{i === 0 ? "★ " : ""}{o.name || "(unnamed)"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.peakSales != null ? Math.round(o.peakSales / 1e6) : "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.launchYear ?? valuation.launchYear ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.loeYear ?? valuation.loeYear ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{fmtPct(o.ptrs, 1)}</td>
                    <td style={{ padding: "6px 8px" }}>{fmtMoney(o.revenuePV)}</td>
                    <td style={{ padding: "6px 8px", color: o.rnpv >= 0 ? "var(--accent)" : "var(--danger)", fontWeight: 700 }}>{fmtMoney(o.rnpv)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid var(--border-strong)", textAlign: "right", color: "var(--text)", fontWeight: 700 }}>
                  <td style={{ textAlign: "left", padding: "6px 8px" }}>Combined</td>
                  <td /><td /><td />
                  <td style={{ padding: "6px 8px" }}>{fmtMoney(out.devCostPV)}</td>
                  <td style={{ padding: "6px 8px" }}>{fmtMoney(out.revenuePV)}</td>
                  <td style={{ padding: "6px 8px", color: out.rnpv >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmtMoney(out.rnpv)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Valuation analysis (tabbed charts) — governed */}
      <Card>
        <SectionLabel>Valuation Analysis</SectionLabel>
        <ValuationCharts valuation={valuation} governed={out} />
      </Card>

      {/* Strategic assessment */}
      {c.valuationBrief && (
        <Card>
          <SectionLabel>Strategic Assessment</SectionLabel>
          <StrategicAssessment brief={c.valuationBrief} summary={c.briefSummary ?? null} loading={false} expectationAudit={c.expectationAudit ?? null} />
        </Card>
      )}

      {/* True effect prior chain */}
      {c.effectPrior && (
        <Card>
          <SectionLabel>True Effect Prior</SectionLabel>
          <EffectPriorChain effectPrior={c.effectPrior} loading={false} ptrsResult={c.ptrsResult ?? null} />
        </Card>
      )}

      {/* Development path */}
      {devPlan && c.devPlanStages && (
        <Card>
          <SectionLabel>Development Path</SectionLabel>
          <DevPlan
            stageInputs={c.devPlanStages}
            regContext={c.devPlanRegContext ?? "standard"}
            devPlan={devPlan}
            reasoning={c.devPlanReasoning ?? null}
            loading={false}
            onUpdateN={() => {}}
            onUpdateCpp={() => {}}
          />
        </Card>
      )}

      {/* Scenarios */}
      {devPlan && (
        <Card>
          <SectionLabel>Scenarios</SectionLabel>
          <ScenarioPanel base={valuation} devPlan={devPlan} />
        </Card>
      )}

      {/* Strategy Advisor — read-only results (option comparison + insight), only if one was generated */}
      {(c.decisionState?.options?.length ?? 0) > 0 && (
        <Card>
          <SectionLabel>Strategy Advisor</SectionLabel>
          <DecisionAnalysis
            valuation={valuation}
            out={out}
            ptrsResult={c.ptrsResult ?? null}
            layer2Result={c.layer2Result ?? null}
            effectPrior={c.effectPrior ?? null}
            devPlan={devPlan}
            persisted={c.decisionState as any}
            programOption={programOption}
            readOnly
          />
        </Card>
      )}
    </div>
  );
}
