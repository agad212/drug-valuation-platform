import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine, ComposedChart, Area, Line, Legend,
} from "recharts";
import type { Valuation } from "../lib/types";
import { computeOutputs, computeRevenuePV } from "../lib/cashflow";

// The memo output the charts READ (never recompute). The main page passes governedOut as the `governed`
// prop; where it's absent (e.g. the read-only share page) the chart falls back to a single deterministic
// computeOutputs — same number, so no drift. Tornado is the ONE exception: it drives the sanctioned
// computeOutputs SWEEP over perturbed input vectors.
type ComputeOut = ReturnType<typeof computeOutputs>;

const fmt = (n: number) => {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 12,
      boxShadow: "var(--shadow-md)"
    }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.value >= 0 ? "var(--accent)" : "var(--danger)", fontWeight: 500 }}>
          {p.name}: {typeof p.value === "number" ? fmt(p.value) : p.value}
        </div>
      ))}
    </div>
  );
}

// ─── Tornado Chart ─────────────────────────────────────────────────────────
function TornadoChart({ valuation }: { valuation: Valuation }) {
  const isMulti = (valuation.indications?.length ?? 0) > 0;
  const base = useMemo(() => computeOutputs(valuation).rnpv, [valuation]);

  const sensitivities = useMemo(() => {
    const deltas: { label: string; low: number; high: number; impact: number }[] = [];

    if (isMulti) {
      // Multi-indication: scale all indication peak sales together, vary global params
      const scalePeakSales = (scale: number) => computeOutputs({
        ...valuation,
        indications: valuation.indications!.map((ind) => ({
          ...ind, peakSales: (ind.peakSales ?? valuation.peakSales ?? 0) * scale,
        })),
      }).rnpv;

      deltas.push({
        label: "Peak Sales (all)",
        low: scalePeakSales(0.75) - base,
        high: scalePeakSales(1.25) - base,
        impact: Math.abs(scalePeakSales(1.25) - scalePeakSales(0.75)),
      });

      const globalParams: Array<{ key: keyof Valuation; label: string; delta: number; isPct?: boolean }> = [
        { key: "ptrs", label: "PTRS", delta: 0.1, isPct: true },
        { key: "discountRate", label: "Discount Rate", delta: 0.03, isPct: true },
        { key: "devCostPV", label: "Dev Cost PV", delta: 0.25 },
        { key: "cogsPct", label: "COGS %", delta: 0.05, isPct: true },
      ];
      for (const p of globalParams) {
        const cur = (valuation[p.key] as number) ?? 0;
        if (!cur) continue;
        const lo = computeOutputs({ ...valuation, [p.key]: cur - p.delta * (p.isPct ? 1 : cur) }).rnpv;
        const hi = computeOutputs({ ...valuation, [p.key]: cur + p.delta * (p.isPct ? 1 : cur) }).rnpv;
        deltas.push({ label: p.label, low: lo - base, high: hi - base, impact: Math.abs(hi - lo) });
      }
    } else {
      const params: Array<{ key: keyof Valuation; label: string; delta: number; isPct?: boolean }> = [
        { key: "peakSales", label: "Peak Sales", delta: 0.25 },
        { key: "ptrs", label: "PTRS", delta: 0.1, isPct: true },
        { key: "discountRate", label: "Discount Rate", delta: 0.03, isPct: true },
        { key: "devCostPV", label: "Dev Cost PV", delta: 0.25 },
        { key: "launchYear", label: "Launch Year", delta: 2 },
        { key: "loeYear", label: "LOE Year", delta: 3 },
        { key: "cogsPct", label: "COGS %", delta: 0.05, isPct: true },
      ];
      for (const p of params) {
        const cur = (valuation[p.key] as number) ?? 0;
        if (!cur) continue;
        const lo = computeOutputs({ ...valuation, [p.key]: cur - p.delta * (p.isPct ? 1 : cur) }).rnpv;
        const hi = computeOutputs({ ...valuation, [p.key]: cur + p.delta * (p.isPct ? 1 : cur) }).rnpv;
        deltas.push({ label: p.label, low: lo - base, high: hi - base, impact: Math.abs(hi - lo) });
      }
    }

    return deltas.sort((a, b) => b.impact - a.impact).slice(0, 6);
  }, [valuation, base, isMulti]);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        Impact on rNPV vs base case ({fmt(base)}){isMulti ? " — combined across all indications" : ""}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={sensitivities} layout="vertical" margin={{ left: 80, right: 20, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 10 }} />
          <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} width={80} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine x={0} stroke="var(--border-strong)" />
          <Bar dataKey="low" name="Low case" stackId="a" fill="var(--danger)" opacity={0.7} radius={[2, 0, 0, 2]} />
          <Bar dataKey="high" name="High case" stackId="b" fill="var(--accent)" opacity={0.7} radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Waterfall Chart ────────────────────────────────────────────────────────
// Reads the memo output `out` (governed prop) — no in-chart recompute.
function WaterfallChart({ out }: { out: ComputeOut }) {
  const data = useMemo(() => {
    const revPV = out.revenuePV;
    // Pre-cost risk-adjusted value the bridge must land on before dev cost. Single-indication:
    // ptrs × revPV (byte-identical to the prior bridge). Multi-indication: rnpv + devCost = the Σ of
    // per-indication structural contributions grossed back up by cost — so the risk step reflects the
    // per-indication P mix, never a single blanket P on pooled revenue, and the bridge reconciles to
    // the same rNPV total shown in the headline.
    const isMulti = out.indicationOutputs.length > 1;
    const preCost = isMulti ? out.rnpv + out.devCostPV : revPV * out.ptrs;
    const ptrsAdj = preCost - revPV;
    const devCost = -out.devCostPV;
    const rnpv = out.rnpv;

    return [
      { name: "Revenue PV", value: revPV, base: 0, isTotal: false },
      { name: "PTRS Adj.", value: ptrsAdj, base: Math.min(revPV, revPV + ptrsAdj), isTotal: false },
      { name: "Dev Cost", value: devCost, base: Math.max(0, preCost + devCost), isTotal: false },
      { name: "rNPV", value: rnpv, base: 0, isTotal: true },
    ];
  }, [out]);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        Bridge from Revenue PV → rNPV
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ left: 10, right: 10, top: 4, bottom: 20 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={fmt} tick={{ fontSize: 10 }} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Bar dataKey="base" fill="transparent" stackId="stack" />
          <Bar dataKey="value" stackId="stack" radius={[4, 4, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.isTotal ? "var(--accent)" : entry.value >= 0 ? "#60a5fa" : "var(--danger)"} opacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Revenue Timeline ────────────────────────────────────────────────────────
function RevenueTimeline({ valuation }: { valuation: Valuation }) {
  const isMulti = (valuation.indications?.length ?? 0) > 0;

  const data = useMemo(() => {
    const now = new Date().getFullYear();
    const disc = valuation.discountRate ?? 0.12;
    const ramps: Record<number, number> = { 0: 0.2, 1: 0.5, 2: 0.8, 3: 1.0 };

    if (isMulti) {
      // Build combined revenue timeline across all indications
      const yearMap = new Map<number, number>();
      for (const ind of valuation.indications!) {
        const ly = ind.launchYear ?? valuation.launchYear;
        const loeY = ind.loeYear ?? valuation.loeYear;
        const ps = ind.peakSales ?? valuation.peakSales;
        if (!ly || !loeY || !ps) continue;
        for (let yr = ly; yr <= loeY + 2; yr++) {
          const i = yr - ly;
          let pct = 1.0;
          if (i <= 3) pct = ramps[i] ?? 1.0;
          else if (yr > loeY) pct = 0.5; // mirror cashflow's post-LOE erosion (was 0.3 — disagreed with the engine)
          yearMap.set(yr, (yearMap.get(yr) ?? 0) + ps * pct);
        }
      }
      return [...yearMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([yr, revenue]) => {
          const df = 1 / Math.pow(1 + disc, Math.max(0, yr - now));
          return { year: yr, revenue: Math.round(revenue / 1e6), pv: Math.round(revenue * df / 1e6), isLOE: false };
        });
    }

    // Single-indication mode
    if (!valuation.launchYear || !valuation.loeYear || !valuation.peakSales) return [];
    const rows = [];
    for (let yr = valuation.launchYear; yr <= valuation.loeYear + 2; yr++) {
      const i = yr - valuation.launchYear;
      let pct = 1.0;
      if (i <= 3) pct = ramps[i] ?? 1.0;
      else if (yr > valuation.loeYear) pct = 0.5; // mirror cashflow's post-LOE erosion (was 0.3)
      const revenue = valuation.peakSales * pct;
      const df = 1 / Math.pow(1 + disc, Math.max(0, yr - now));
      rows.push({ year: yr, revenue: Math.round(revenue / 1e6), pv: Math.round(revenue * df / 1e6), isLOE: yr > valuation.loeYear });
    }
    return rows;
  }, [valuation, isMulti]);

  if (!data.length) return <div style={{ color: "var(--text-faint)", fontSize: 13 }}>Set Launch Year, LOE Year, and Peak Sales to see timeline.</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        {isMulti ? "Combined annual revenue ($M) across all indications with PV overlay" : "Annual revenue ($M nominal) with PV overlay — post-LOE shaded"}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ left: 10, right: 10, top: 4, bottom: 20 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="year" tick={{ fontSize: 10 }} />
          <YAxis tickFormatter={(v) => `$${v}M`} tick={{ fontSize: 10 }} />
          <Tooltip content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null;
            return (
              <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
                {payload.map((p: any, i: number) => <div key={i} style={{ color: "var(--text)" }}>{p.name}: ${p.value}M</div>)}
              </div>
            );
          }} />
          <Bar dataKey="revenue" name="Revenue" fill="var(--accent)" opacity={0.3} radius={[3, 3, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.isLOE ? "var(--danger)" : "var(--accent)"} opacity={entry.isLOE ? 0.2 : 0.35} />
            ))}
          </Bar>
          <Line dataKey="pv" name="PV" type="monotone" stroke="var(--accent)" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Indications Breakdown Chart ─────────────────────────────────────────────
// Reads the memo output `out` (governed prop) — no in-chart recompute.
function IndicationsChart({ out }: { out: ComputeOut }) {
  if (!out.indicationOutputs.length) {
    return <div style={{ color: "var(--text-faint)", fontSize: 13 }}>Add indications to see breakdown.</div>;
  }

  const data = out.indicationOutputs.map((ind) => ({
    name: ind.name || "Unnamed",
    revenuePV: ind.revenuePV,
    rnpv: ind.rnpv,
  }));

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        Revenue PV vs risk-adjusted NPV by indication (before dev cost allocation)
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ left: 10, right: 10, top: 4, bottom: 50 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
          <YAxis tickFormatter={fmt} tick={{ fontSize: 10 }} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="revenuePV" name="Revenue PV" fill="#60a5fa" opacity={0.45} radius={[4, 4, 0, 0]} />
          <Bar dataKey="rnpv" name="rNPV" radius={[4, 4, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.rnpv >= 0 ? "var(--accent)" : "var(--danger)"} opacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Multi-indication Structure (the resolved relationships, RENDERED) ────────
// Reads the RESOLVED structure from out.indicationOutputs (indicationRelationship + the additive
// effLaunch / conditionalPWeight the engine now surfaces) — a READ, never a second judgment. Bars on a
// shared calendar-year axis: independent → parallel; sequential-after → staggered at the prerequisite's
// launch (from effLaunch) with a connector; conditional-on → gated (◆) + hatched + P-weight, rationale
// on hover.
function StructureGantt({ out, valuation }: { out: ComputeOut; valuation: Valuation }) {
  const inds = out.indicationOutputs;
  if (inds.length < 2) return <div style={{ color: "var(--text-faint)", fontSize: 13 }}>Two or more indications needed to show structure.</div>;

  const byId = new Map(inds.map((i) => [i.id, i]));
  const startOf = (i: typeof inds[number]) => i.effLaunch ?? i.launchYear ?? valuation.launchYear ?? new Date().getFullYear();
  const endOf = (i: typeof inds[number]) => i.loeYear ?? valuation.loeYear ?? (startOf(i) + 10);
  const yearMin = Math.min(...inds.map(startOf));
  const yearMax = Math.max(...inds.map(endOf));
  const span = Math.max(1, yearMax - yearMin);
  const pctL = (yr: number) => ((yr - yearMin) / span) * 100;
  const relOf = (rel: string | undefined) => {
    if (typeof rel === "string" && rel.startsWith("conditional-on:")) return { kind: "conditional" as const, ref: rel.slice("conditional-on:".length) };
    if (typeof rel === "string" && rel.startsWith("sequential-after:")) return { kind: "sequential" as const, ref: rel.slice("sequential-after:".length) };
    return { kind: "independent" as const, ref: null };
  };
  const gridYears: number[] = [];
  for (let y = yearMin; y <= yearMax; y += Math.max(1, Math.ceil(span / 8))) gridYears.push(y);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
        Indication structure — parallel (independent), staggered (sequential-after), or gated (conditional-on). Each bar spans launch→LOE at its own P.
      </div>
      {/* year axis */}
      <div style={{ position: "relative", height: 16, marginLeft: 150, marginBottom: 4 }}>
        {gridYears.map((y) => (
          <div key={y} style={{ position: "absolute", left: `${pctL(y)}%`, fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--font-mono)", transform: "translateX(-50%)" }}>{y}</div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {inds.map((ind, idx) => {
          const rel = idx === 0 ? { kind: "independent" as const, ref: null } : relOf(ind.indicationRelationship);
          const s = startOf(ind), e = endOf(ind);
          const prereq = rel.ref ? byId.get(rel.ref) : null;
          const conditional = rel.kind === "conditional";
          const barColor = ind.rnpv >= 0 ? "var(--accent)" : "var(--danger)";
          const title = `${ind.name || "indication"} · P ${(ind.ptrs * 100).toFixed(0)}% · rNPV ${fmt(ind.rnpv)} · ${rel.kind}${prereq ? ` ${prereq.name}` : ""}${conditional && ind.conditionalPWeight != null ? ` (P-weight ×${(ind.conditionalPWeight).toFixed(2)})` : ""}`;
          return (
            <div key={ind.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* label */}
              <div style={{ width: 142, flexShrink: 0, textAlign: "right", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                <div style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{idx === 0 ? "★ " : ""}{ind.name || "(unnamed)"}</div>
                <div style={{ color: "var(--text-faint)", fontSize: 9 }}>
                  {rel.kind === "independent" ? "independent" : rel.kind === "sequential" ? `↳ after ${prereq?.name ?? rel.ref}` : `⧖ gated on ${prereq?.name ?? rel.ref}`}
                </div>
              </div>
              {/* track */}
              <div style={{ position: "relative", flex: 1, height: 26, background: "var(--surface-2, rgba(120,120,120,0.06))", borderRadius: 6 }} title={title}>
                {conditional && (
                  <div title="gate: only proceeds if the prerequisite succeeds" style={{ position: "absolute", left: `calc(${pctL(s)}% - 6px)`, top: 5, fontSize: 14, color: "#f59e0b", lineHeight: 1 }}>◆</div>
                )}
                <div style={{
                  position: "absolute", left: `${pctL(s)}%`, width: `${Math.max(1.5, pctL(e) - pctL(s))}%`, top: 5, height: 16, borderRadius: 4,
                  background: barColor, opacity: conditional ? 0.4 : 0.82,
                  backgroundImage: conditional ? "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.25) 3px, rgba(255,255,255,0.25) 6px)" : undefined,
                  border: `1px solid ${barColor}`,
                }} />
                <div style={{ position: "absolute", left: `calc(${pctL(s)}% + 4px)`, top: 6, fontSize: 9.5, color: "#fff", fontFamily: "var(--font-mono)", fontWeight: 700, pointerEvents: "none", textShadow: "0 1px 2px rgba(0,0,0,0.4)" }}>
                  {(ind.ptrs * 100).toFixed(0)}% · {fmt(ind.rnpv)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {out.indicationFlags.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 3 }}>
          {out.indicationFlags.map((f, i) => (
            <div key={i} style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--font-mono)", lineHeight: 1.4 }}>· {f}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Export ────────────────────────────────────────────────────────────
type Tab = "Tornado" | "Waterfall" | "Timeline" | "Structure" | "Indications";

export default function ValuationCharts({ valuation, governed }: { valuation: Valuation; governed?: ComputeOut }) {
  // READ the memo output; fall back to a single deterministic recompute only when no prop is passed
  // (e.g. the read-only share page). Tornado is the one chart that sweeps computeOutputs itself.
  const out = useMemo(() => governed ?? computeOutputs(valuation), [governed, valuation]);
  const nInd = out.indicationOutputs.length;
  const [tab, setTab] = React.useState<Tab>("Tornado");
  const tabs: Tab[] = nInd > 1
    ? ["Tornado", "Waterfall", "Timeline", "Structure", "Indications"]
    : nInd === 1
    ? ["Tornado", "Waterfall", "Timeline", "Indications"]
    : ["Tornado", "Waterfall", "Timeline"];

  // Reset to Tornado if the active tab is no longer available (indications removed / dropped below 2).
  React.useEffect(() => {
    if ((tab === "Indications" && nInd === 0) || (tab === "Structure" && nInd <= 1)) setTab("Tornado");
  }, [nInd, tab]);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="btn" style={{
            fontSize: 12, padding: "4px 12px",
            background: tab === t ? "var(--accent)" : "transparent",
            color: tab === t ? "var(--accent-fg)" : "var(--text-muted)",
            border: `1px solid ${tab === t ? "var(--accent)" : "var(--border)"}`,
          }}>
            {t}
          </button>
        ))}
      </div>
      <div className="animate-fade-in">
        {tab === "Tornado"     && <TornadoChart valuation={valuation} />}
        {tab === "Waterfall"   && <WaterfallChart out={out} />}
        {tab === "Timeline"    && <RevenueTimeline valuation={valuation} />}
        {tab === "Structure"   && <StructureGantt out={out} valuation={valuation} />}
        {tab === "Indications" && <IndicationsChart out={out} />}
      </div>
    </div>
  );
}
