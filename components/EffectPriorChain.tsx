// ─── True Effect Prior — Evidence Chain (story UI) ─────────────────────────────
//
// Step-by-step, jargon-light walkthrough of how the True Effect Prior mixture
// was built: mechanism -> animal -> analog -> own clinical evidence. The header
// card shows the overall result (one curve normally, or two if the evidence
// genuinely points to two different possible outcomes). Each step card below
// shows what was found, whether it agreed with the running estimate, and a
// before/after curve of the running "effect strength" estimate.
//
// Step 1 (mechanism) nests the 9-factor mechanism breakdown (MechanismSection,
// moved here from DevPlan.tsx) since that's the evidence behind this step's
// starting curve.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from "react";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer } from "recharts";
import {
  mixtureMoments,
  type EffectPrior,
  type EffectPriorMixture,
  type GaussianComponent,
  type ChainStep,
  type EvidenceSourceType,
} from "../lib/effect-prior";

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = {
  effectPrior: EffectPrior | null;
  loading: boolean;
  ptrsResult: any | null;
};

// ─── Curve math (pure) ──────────────────────────────────────────────────────

function gaussianPdf(x: number, mu: number, sigma2: number): number {
  const s2 = Math.max(sigma2, 1e-6);
  return Math.exp(-((x - mu) ** 2) / (2 * s2)) / Math.sqrt(2 * Math.PI * s2);
}

function mixturePdf(x: number, mixture: EffectPriorMixture): number {
  return mixture.reduce((sum, c) => sum + c.w * gaussianPdf(x, c.mu, c.sigma2), 0);
}

// x-range covering +/-3 SD of every component across the given mixtures.
function curveRange(mixtures: EffectPriorMixture[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of mixtures) {
    for (const c of m) {
      const sd = Math.sqrt(Math.max(c.sigma2, 1e-6));
      lo = Math.min(lo, c.mu - 3 * sd);
      hi = Math.max(hi, c.mu + 3 * sd);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 2];
  if (hi - lo < 0.5) {
    const mid = (hi + lo) / 2;
    return [mid - 0.5, mid + 0.5];
  }
  return [lo, hi];
}

const CURVE_POINTS = 60;

function sampleCurve(mixture: EffectPriorMixture, xMin: number, xMax: number, points: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const step = (xMax - xMin) / (points - 1);
  for (let i = 0; i < points; i++) {
    const x = xMin + i * step;
    out.push({ x, y: mixturePdf(x, mixture) });
  }
  return out;
}

// Before/after density curves over a shared x-range, for one chain step.
function beforeAfterData(before: EffectPriorMixture, after: EffectPriorMixture) {
  const [xMin, xMax] = curveRange([before, after]);
  const beforeSamples = sampleCurve(before, xMin, xMax, CURVE_POINTS);
  const afterSamples = sampleCurve(after, xMin, xMax, CURVE_POINTS);
  return beforeSamples.map((b, i) => ({ x: b.x, before: b.y, after: afterSamples[i].y }));
}

// Final-result chart data: 1 curve (unimodal) or 2 weight-scaled curves
// (bimodal), sorted so "weaker" is always the lower-mu component.
function finalCurveData(mixture: EffectPriorMixture, isBimodal: boolean) {
  const [xMin, xMax] = curveRange([mixture]);

  if (!isBimodal) {
    const data = sampleCurve(mixture, xMin, xMax, CURVE_POINTS).map((p) => ({ x: p.x, single: p.y }));
    return { data, weaker: null as GaussianComponent | null, stronger: null as GaussianComponent | null };
  }

  const [weaker, stronger] = [...mixture].sort((a, b) => a.mu - b.mu);
  const step = (xMax - xMin) / (CURVE_POINTS - 1);
  const data: { x: number; weakerY: number; strongerY: number }[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = xMin + i * step;
    data.push({
      x,
      weakerY: weaker.w * gaussianPdf(x, weaker.mu, weaker.sigma2),
      strongerY: stronger.w * gaussianPdf(x, stronger.mu, stronger.sigma2),
    });
  }
  return { data, weaker, stronger };
}

// ─── Display helpers ────────────────────────────────────────────────────────

// "Effect strength" on a 0-100 scale, same as MSS*100 (mu = mss * 2).
function strengthScore(mu: number): number {
  return Math.round((mu / 2) * 100);
}

function confidenceLabel(sigma2: number): string {
  if (sigma2 <= 0.08) return "High confidence";
  if (sigma2 <= 0.2) return "Medium confidence";
  return "Low confidence";
}

function strengthColor(mu: number): string {
  const s = mu / 2;
  if (s >= 0.75) return "#10b981";
  if (s >= 0.55) return "#3b82f6";
  return "#f59e0b";
}

function probColor(p: number): string {
  if (p >= 0.70) return "#10b981";
  if (p >= 0.50) return "#3b82f6";
  if (p >= 0.35) return "#f59e0b";
  return "#ef4444";
}

function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// ─── Step metadata ──────────────────────────────────────────────────────────

const AGREEMENT_STYLE: Record<ChainStep["agreement"], { color: string; label: string }> = {
  agree: { color: "var(--accent)", label: "✓ Matches what we believed so far" },
  disagree: { color: "var(--warning)", label: "⚠ Points a different direction" },
  "n/a": { color: "var(--text-faint)", label: "No usable evidence — estimate unchanged" },
};

const STEP_META: Record<EvidenceSourceType, { title: string; blurb: string }> = {
  mechanism: {
    title: "Step 1 · What does the biology say?",
    blurb: "How the drug is designed to work — its target, potency, and biological rationale.",
  },
  animal: {
    title: "Step 2 · What happened in animal studies?",
    blurb: "Whether animal efficacy data backs up what the mechanism predicts.",
  },
  analog: {
    title: "Step 3 · What happened with similar drugs?",
    blurb: "How other drugs with a similar target or mechanism have performed in human trials.",
  },
  own_clinical: {
    title: "Step 4 · What has this drug shown in its own trials?",
    blurb: "This drug's own clinical data so far, if any exists yet.",
  },
};

// ─── Mechanism section (moved from DevPlan.tsx — the evidence behind Step 1) ──

const FACTOR_LABELS: Record<string, string> = {
  potency: "1A · Potency",
  selectivity: "1B · Selectivity",
  pkProfile: "1C · PK Profile",
  targetEngagement: "1D · Target Engagement",
  therapeuticWindow: "1E · Therapeutic Window",
  targetValidation: "2A · Target Validation",
  indicationMechFit: "2B · Indication Fit",
  modalityFit: "2C · Modality Fit",
  translationRate: "2D · Translation Rate",
};

function scoreColor(s: number): string {
  if (s >= 0.75) return "#10b981";
  if (s >= 0.5) return "#f59e0b";
  return "#ef4444";
}

function MechanismSection({ ptrsResult }: { ptrsResult: any }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: "var(--surface-2)", borderRadius: 10,
      border: "1px solid var(--border)", marginTop: 12, overflow: "hidden",
    }}>
      {/* Header row — always visible */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "12px 16px", cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", flexShrink: 0 }}>
          Mechanism inputs
        </div>
        {/* MSS / IPS / TRS badges */}
        {[
          { label: "MSS", val: ptrsResult.mss, desc: "Signal Strength" },
          { label: "IPS", val: ptrsResult.ips, desc: "Potency" },
          { label: "TRS", val: ptrsResult.trs, desc: "Translation" },
        ].map(({ label, val, desc }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{desc}</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontWeight: 700,
              fontSize: 15, color: scoreColor(val),
            }}>{Math.round(val * 100)}</span>
            <span style={{ fontSize: 9, color: "var(--text-faint)" }}>/{label}</span>
          </div>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-faint)" }}>
          {expanded ? "▲ hide factors" : "▼ factor breakdown"}
        </div>
      </div>

      {/* Collapsible factor breakdown */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
          {ptrsResult.summary && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
              {ptrsResult.summary}
            </div>
          )}
          {Object.entries(ptrsResult.factors).map(([key, factor]: [string, any]) => (
            <div key={key} style={{
              display: "grid", gridTemplateColumns: "170px 44px 60px 1fr",
              gap: 8, alignItems: "center",
              padding: "7px 0", borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {FACTOR_LABELS[key] || key}
              </div>
              <div style={{
                fontSize: 14, fontWeight: 700, color: scoreColor(factor.score),
                fontFamily: "var(--font-display)", textAlign: "right",
              }}>
                {Math.round(factor.score * 100)}
              </div>
              <div style={{ fontSize: 10, color: factor.confidence === "unknown" ? "#f59e0b" : "var(--text-faint)", textTransform: "uppercase" }}>
                {factor.confidence}{factor.highVariance ? " ⚠" : ""}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {factor.rationale}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Step card ──────────────────────────────────────────────────────────────

function StepCard({ step, index, ptrsResult }: { step: ChainStep; index: number; ptrsResult: any }) {
  const [showReasoning, setShowReasoning] = useState(true);
  const meta = STEP_META[step.source] ?? { title: step.label, blurb: "" };
  const isFirst = index === 0;
  const badge = isFirst ? { color: "var(--text-faint)", label: "Starting point" } : AGREEMENT_STYLE[step.agreement];

  const after = mixtureMoments(step.mixtureAfter);
  const before = isFirst ? null : mixtureMoments(step.mixtureBefore);
  const chartData = beforeAfterData(step.mixtureBefore, step.mixtureAfter);

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "16px 18px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>
            {meta.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{meta.blurb}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
          background: `${badge.color}1A`, color: badge.color, whiteSpace: "nowrap", flexShrink: 0,
        }}>
          {badge.label}
        </span>
      </div>

      {/* AI evidence label */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", marginBottom: 10 }}>
        {step.label}
      </div>

      {!step.found ? (
        <div style={{ fontSize: 12, color: "var(--text-faint)", padding: "8px 0" }}>
          {step.reasoning}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          {/* Before/after stats */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexShrink: 0 }}>
            {before && (
              <>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 2 }}>Before</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
                    {strengthScore(before.mss * 2)}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--text-faint)" }}>{confidenceLabel(before.variance)}</div>
                  <div style={{ fontSize: 8, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginTop: 1 }}>
                    σ² {before.variance.toFixed(2)}
                  </div>
                </div>
                <div style={{ fontSize: 18, color: "var(--text-faint)" }}>→</div>
              </>
            )}
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 2 }}>{before ? "After" : "Starting estimate"}</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)", color: strengthColor(after.mss * 2) }}>
                {strengthScore(after.mss * 2)}
              </div>
              <div style={{ fontSize: 9, color: "var(--text-faint)" }}>{confidenceLabel(after.variance)}</div>
              <div style={{ fontSize: 8, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginTop: 1 }}>
                σ² {after.variance.toFixed(2)}
              </div>
            </div>
            {step.mixtureAfter.length === 2 && (
              <div style={{ fontSize: 11, color: "var(--warning)", maxWidth: 160, lineHeight: 1.4 }}>
                The evidence has split into two possible stories — see the chart →
              </div>
            )}
          </div>

          {/* Curve chart */}
          <div style={{ flex: "1 1 240px", minWidth: 220, height: 110 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <XAxis
                  dataKey="x" type="number" domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 9 }} tickFormatter={(v) => String(strengthScore(v))}
                />
                <YAxis hide domain={[0, "auto"]} />
                {!isFirst && (
                  <Area
                    type="monotone" dataKey="before"
                    stroke="var(--text-faint)" fill="var(--text-faint)" fillOpacity={0.08}
                    strokeWidth={1.5} strokeDasharray="3 3" isAnimationActive={false}
                  />
                )}
                <Area
                  type="monotone" dataKey="after"
                  stroke={badge.color} fill={badge.color} fillOpacity={0.18}
                  strokeWidth={2} isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 14, justifyContent: "center", fontSize: 9, color: "var(--text-faint)", marginTop: 2 }}>
              {!isFirst && (
                <span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--text-faint)", marginRight: 4, opacity: 0.5 }} />
                  Before this step
                </span>
              )}
              <span>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: badge.color, marginRight: 4 }} />
                {isFirst ? "Starting estimate" : "After this step"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Reasoning */}
      {step.found && step.reasoning && (
        <div>
          <div
            onClick={() => setShowReasoning((s) => !s)}
            style={{ fontSize: 11, color: "var(--text-faint)", cursor: "pointer", marginBottom: showReasoning ? 4 : 0 }}
          >
            {showReasoning ? "▲ hide reasoning" : "▼ why?"}
          </div>
          {showReasoning && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {step.reasoning}
            </div>
          )}
        </div>
      )}

      {/* Step 1: nest the mechanism factor breakdown */}
      {step.source === "mechanism" && ptrsResult && <MechanismSection ptrsResult={ptrsResult} />}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function EffectPriorChain({ effectPrior, loading, ptrsResult }: Props) {
  if (loading && !effectPrior) {
    return (
      <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: 13 }}>
        ⏳ Gathering animal, analog, and clinical evidence…
      </div>
    );
  }

  if (!effectPrior) return null;

  const { mixture, shape, chain } = effectPrior;
  const isBimodal = shape === "bimodal";
  const { mss, variance } = mixtureMoments(mixture);
  const effectScore = Math.round(mss * 100);
  const { data: finalData, weaker, stronger } = finalCurveData(mixture, isBimodal);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Header / final result */}
      <div style={{ background: "linear-gradient(135deg, #1e1b4b, #312e81)", borderRadius: 12, padding: "18px 20px" }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
          True Effect Prior — what does all the evidence add up to?
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: "1 1 260px" }}>
            {isBimodal ? (
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", lineHeight: 1.7, margin: 0 }}>
                The evidence doesn&apos;t agree on a single story — it looks like a coin-flip between
                two different possible realities for this drug. Below is each scenario, weighted
                by how likely it is given everything we&apos;ve seen so far.
              </p>
            ) : (
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", lineHeight: 1.7, margin: 0 }}>
                The evidence below tells a broadly consistent story. Combining mechanism, animal,
                analog, and clinical evidence gives one running estimate of this drug&apos;s true effect.
              </p>
            )}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>
                {isBimodal ? "Weighted effect strength across both scenarios" : "Combined effect strength estimate"}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontSize: 36, fontWeight: 800, fontFamily: "var(--font-display)", color: strengthColor(mss * 2), lineHeight: 1 }}>
                  {effectScore}
                </div>
                <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)" }}>/100</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginLeft: 4 }}>
                  {confidenceLabel(variance)}
                </div>
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                How strong the drug effect appears to be — trial probability is in the Development Path below
              </div>
            </div>
            {isBimodal && weaker && stronger && (
              <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                <div>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#f59e0b", marginRight: 6 }} />
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>Weaker-effect scenario — {fmtPct(weaker.w)} likely</span>
                </div>
                <div>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--accent)", marginRight: 6 }} />
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>Stronger-effect scenario — {fmtPct(stronger.w)} likely</span>
                </div>
              </div>
            )}
          </div>
          <div style={{ flex: "1 1 280px", minWidth: 240, height: 150 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={finalData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <XAxis
                  dataKey="x" type="number" domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.5)" }} tickFormatter={(v) => String(strengthScore(v))}
                />
                <YAxis hide domain={[0, "auto"]} />
                {isBimodal ? (
                  <>
                    <Area type="monotone" dataKey="weakerY" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
                    <Area type="monotone" dataKey="strongerY" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
                  </>
                ) : (
                  <Area type="monotone" dataKey="single" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
                )}
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ textAlign: "center", fontSize: 9, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
              Effect strength (0 = none, 100 = strong)
            </div>
          </div>
        </div>
      </div>

      {/* Step-by-step story */}
      {chain.map((step, i) => (
        <StepCard key={step.source} step={step} index={i} ptrsResult={ptrsResult} />
      ))}
    </div>
  );
}
