import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine, ComposedChart, Area, Line, Legend,
} from "recharts";
import type { Valuation } from "../lib/types";
import { computeOutputs, computeRevenuePV } from "../lib/cashflow";

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
function WaterfallChart({ valuation }: { valuation: Valuation }) {
  const out = useMemo(() => computeOutputs(valuation), [valuation]);

  const data = useMemo(() => {
    const revPV = out.revenuePV;
    const ptrsAdj = revPV * out.ptrs - revPV;
    const devCost = -out.devCostPV;
    const rnpv = out.rnpv;

    return [
      { name: "Revenue PV", value: revPV, base: 0, isTotal: false },
      { name: "PTRS Adj.", value: ptrsAdj, base: Math.min(revPV, revPV + ptrsAdj), isTotal: false },
      { name: "Dev Cost", value: devCost, base: Math.max(0, revPV * out.ptrs + devCost), isTotal: false },
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
          else if (yr > loeY) pct = 0.3;
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
      else if (yr > valuation.loeYear) pct = 0.3;
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
function IndicationsChart({ valuation }: { valuation: Valuation }) {
  const out = useMemo(() => computeOutputs(valuation), [valuation]);

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

// ─── Main Export ────────────────────────────────────────────────────────────
const ALL_TABS = ["Tornado", "Waterfall", "Timeline", "Indications"] as const;
type Tab = typeof ALL_TABS[number];

export default function ValuationCharts({ valuation }: { valuation: Valuation }) {
  const [tab, setTab] = React.useState<Tab>("Tornado");
  const hasIndications = (valuation.indications?.length ?? 0) > 0;
  const tabs = hasIndications ? ALL_TABS : (["Tornado", "Waterfall", "Timeline"] as const);

  // Reset to Tornado if Indications tab was selected but indications removed
  React.useEffect(() => {
    if (tab === "Indications" && !hasIndications) setTab("Tornado");
  }, [hasIndications, tab]);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t as Tab)} className="btn" style={{
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
        {tab === "Waterfall"   && <WaterfallChart valuation={valuation} />}
        {tab === "Timeline"    && <RevenueTimeline valuation={valuation} />}
        {tab === "Indications" && <IndicationsChart valuation={valuation} />}
      </div>
    </div>
  );
}
