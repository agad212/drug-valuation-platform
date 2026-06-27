// ─── Strategic Assessment Component ───────────────────────────────────────────
//
// Displays the Lead Reasoner's valuationBrief as a headline card: the strategic
// assessment a biotech executive would want to see FIRST. Shows what the company
// is actually trying to do, which trial is the efficacy gate, confidence tags,
// and the expectation anchor. Plain language, no jargon.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from "react";
import type { ValuationBrief, ExpectationAuditResult, ConfidenceLevel } from "../lib/valuation-brief";

type Props = {
  brief: ValuationBrief | null;
  summary: string | null;
  loading: boolean;
  expectationAudit: ExpectationAuditResult | null;
};

const CONF_STYLE: Record<ConfidenceLevel, { color: string; label: string; bg: string }> = {
  CONFIRMED:        { color: "#10b981", label: "Confirmed",        bg: "#10b98118" },
  STRONG_INFERENCE: { color: "#3b82f6", label: "Strong inference", bg: "#3b82f618" },
  WEAK_INFERENCE:   { color: "#f59e0b", label: "Weak inference",   bg: "#f59e0b18" },
  SPECULATIVE:      { color: "#ef4444", label: "Speculative",      bg: "#ef444418" },
};

function ConfBadge({ level }: { level: ConfidenceLevel }) {
  const s = CONF_STYLE[level] ?? CONF_STYLE.WEAK_INFERENCE;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
      background: s.bg, color: s.color, textTransform: "uppercase", letterSpacing: "0.05em",
    }}>
      {s.label}
    </span>
  );
}

function TaggedRow({ label, value, confidence, source }: {
  label: string; value: string; confidence: ConfidenceLevel; source?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>{value}</div>
        {source && <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 1 }}>{source}</div>}
      </div>
      <ConfBadge level={confidence} />
    </div>
  );
}

export default function StrategicAssessment({ brief, summary, loading, expectationAudit }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (loading && !brief) {
    return (
      <div style={{
        background: "linear-gradient(135deg, #1e1b4b, #312e81)", borderRadius: 14,
        padding: "20px 24px", textAlign: "center", color: "rgba(255,255,255,0.7)", fontSize: 13,
      }}>
        Forming strategic assessment — investigating trials, company strategy, and competitive landscape…
      </div>
    );
  }

  if (!brief) return null;

  const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;

  return (
    <div style={{
      background: "linear-gradient(135deg, #1e1b4b, #312e81)", borderRadius: 14,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "18px 22px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
              Strategic Assessment
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", fontFamily: "var(--font-display)" }}>
              {brief.drug}
              <span style={{ fontSize: 13, fontWeight: 400, color: "rgba(255,255,255,0.6)", marginLeft: 8 }}>
                {brief.sponsor}
              </span>
            </div>
          </div>
          {brief.is_low_confidence && (
            <div style={{
              fontSize: 10, fontWeight: 700, padding: "4px 12px", borderRadius: 20,
              background: "rgba(239,68,68,0.2)", color: "#f87171",
            }}>
              LOW CONFIDENCE
            </div>
          )}
        </div>

        {/* Expectation anchor */}
        <div style={{
          display: "inline-block", marginTop: 10, padding: "4px 12px",
          background: "rgba(255,255,255,0.08)", borderRadius: 8,
          fontSize: 11, color: "rgba(255,255,255,0.65)",
        }}>
          Prior expectation: {fmtPct(brief.expectation_anchor.range_low)}–{fmtPct(brief.expectation_anchor.range_high)} P(approval)
          <span style={{ color: "rgba(255,255,255,0.4)", marginLeft: 6 }}>
            — {brief.expectation_anchor.reason.slice(0, 120)}{brief.expectation_anchor.reason.length > 120 ? "…" : ""}
          </span>
        </div>
      </div>

      {/* Expectation audit result (smoke detector) */}
      {expectationAudit && expectationAudit.divergence !== "none" && (
        <div style={{
          margin: "0 22px 12px", padding: "10px 14px", borderRadius: 8,
          background: expectationAudit.divergence === "sharp"
            ? "rgba(239,68,68,0.15)" : "rgba(251,191,36,0.12)",
          border: `1px solid ${expectationAudit.divergence === "sharp" ? "rgba(239,68,68,0.3)" : "rgba(251,191,36,0.25)"}`,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4,
            color: expectationAudit.corrections_made.length > 0 ? "#10b981" : (expectationAudit.divergence === "sharp" ? "#f87171" : "#fbbf24"),
          }}>
            {expectationAudit.corrections_made.length > 0
              ? "Divergence Detected → Inputs Corrected → Re-ran"
              : expectationAudit.divergence === "sharp" ? "Sharp Divergence — Audit" : "Mild Divergence — Check"}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", lineHeight: 1.6 }}>
            {expectationAudit.conclusion}
          </div>
          {expectationAudit.corrections_made.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 10, color: "rgba(16,185,129,0.8)", fontWeight: 700, marginBottom: 2 }}>Corrections applied:</div>
              {expectationAudit.corrections_made.map((c, i) => (
                <div key={i} style={{ fontSize: 11, color: "rgba(16,185,129,0.7)", padding: "1px 0" }}>{c}</div>
              ))}
            </div>
          )}
          {expectationAudit.audit_findings.length > 0 && (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 6 }}>
              {expectationAudit.audit_findings.map((f, i) => (
                <div key={i}>{f}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary (AI explanation) */}
      {summary && (
        <div style={{ padding: "0 22px 14px", fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.7 }}>
          {summary.slice(0, 500)}{summary.length > 500 ? "…" : ""}
        </div>
      )}

      {/* Expandable detail */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          padding: "8px 22px", cursor: "pointer",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: 11, color: "rgba(255,255,255,0.45)",
          display: "flex", justifyContent: "space-between",
        }}
      >
        <span>{expanded ? "▲ Hide detail" : "▼ Show assessment detail"}</span>
        <span>{brief.sources_consulted.length} sources consulted</span>
      </div>

      {expanded && (
        <div style={{ padding: "0 22px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
          <TaggedRow
            label="True development stage"
            value={brief.true_stage.value}
            confidence={brief.true_stage.confidence}
            source={brief.true_stage.source}
          />
          <TaggedRow
            label="Efficacy gate trial"
            value={`${brief.efficacy_gate_trial.trial_name || brief.efficacy_gate_trial.trial_id} — ${brief.efficacy_gate_trial.reason}`}
            confidence={brief.efficacy_gate_trial.confidence}
          />
          <TaggedRow
            label="Base case indication"
            value={brief.base_case_indication.value}
            confidence={brief.base_case_indication.confidence}
            source={brief.base_case_indication.source}
          />
          <TaggedRow
            label="Primary endpoint"
            value={brief.base_case_endpoint.value}
            confidence={brief.base_case_endpoint.confidence}
          />
          <TaggedRow
            label="Comparator / SOC"
            value={`${brief.comparator.value} — SOC RR: ${fmtPct(brief.soc_response_rate.value)}`}
            confidence={brief.soc_response_rate.confidence}
            source={brief.soc_response_rate.source}
          />

          {brief.excluded_trials.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                Excluded trials (not efficacy gates)
              </div>
              {brief.excluded_trials.map((t, i) => (
                <div key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", padding: "2px 0" }}>
                  {t.trial_id}{t.trial_name ? ` (${t.trial_name})` : ""} — {t.reason_excluded}
                </div>
              ))}
            </div>
          )}

          {/* Strategy: confirmed vs inferred */}
          {(brief.confirmed_strategy.length > 0 || brief.inferred_strategy.length > 0) && (
            <div style={{ marginTop: 8 }}>
              {brief.confirmed_strategy.map((s, i) => (
                <div key={`c${i}`} style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", padding: "2px 0" }}>
                  <ConfBadge level="CONFIRMED" /> <span style={{ marginLeft: 6 }}>{s}</span>
                </div>
              ))}
              {brief.inferred_strategy.map((s, i) => (
                <div key={`i${i}`} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", padding: "2px 0" }}>
                  <ConfBadge level="STRONG_INFERENCE" /> <span style={{ marginLeft: 6 }}>{s}</span>
                </div>
              ))}
            </div>
          )}

          {/* Risks and value drivers */}
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", marginBottom: 4 }}>Key risks</div>
              {brief.key_risks.map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: "rgba(248,113,113,0.8)", padding: "2px 0" }}>— {r}</div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", marginBottom: 4 }}>Value drivers</div>
              {brief.key_value_drivers.map((d, i) => (
                <div key={i} style={{ fontSize: 11, color: "rgba(16,185,129,0.8)", padding: "2px 0" }}>— {d}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
