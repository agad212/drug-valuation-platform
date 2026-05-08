import React, { useEffect, useRef, useState } from "react";

const FIELD_LABELS: Record<string, string> = {
  peakSales: "Peak Sales", discountRate: "Discount Rate", cogsPct: "COGS %",
  taxRate: "Tax Rate", workingCapitalPct: "Working Capital %", avgRoyalty: "Avg Royalty %",
  launchYear: "Launch Year", loeYear: "LOE Year", devCostPV: "Dev Cost PV",
  phase: "Phase", ptrs: "PTRS", asset: "Asset", indication: "Indication",
  mechanism: "Mechanism", sponsor: "Sponsor",
};

function formatFieldValue(key: string, value: any): string {
  if (value === null || value === undefined) return "—";
  const pctFields = ["discountRate", "cogsPct", "taxRate", "workingCapitalPct", "avgRoyalty", "ptrs"];
  const moneyFields = ["peakSales", "devCostPV"];
  if (pctFields.includes(key)) return (value * 100).toFixed(1) + "%";
  if (moneyFields.includes(key)) {
    const n = Number(value);
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
    return `$${n.toLocaleString()}`;
  }
  return String(value);
}

type Message = {
  role: "user" | "assistant";
  content: string;
  fieldUpdates?: Record<string, any> | null;
  isStatus?: boolean;
};

interface Props {
  valuation: any;
  onFieldUpdate?: (updates: Record<string, any>) => void;
  onAutoValue?: (drug: string, sponsor?: string, phase?: string) => Promise<string | null>;
}

const AssistantPanel: React.FC<Props> = ({ valuation, onFieldUpdate, onAutoValue }) => {
  const hasAsset = !!(valuation?.asset || valuation?.name);

  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Type a drug name to build a full valuation — I'll scan clinical trials, FDA, patents, and market data automatically. Or ask me anything about an existing valuation.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content) return;
    const userMsg: Message = { role: "user", content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context: { type: "valuation", payload: valuation } }),
      });
      const data = await res.json();

      const replyMsg: Message = {
        role: "assistant",
        content: data?.message || "No reply.",
        fieldUpdates: data?.fieldUpdates || null,
      };
      setMessages((m) => [...m, replyMsg]);

      // Handle auto-value trigger
      if (data?.autoValueTrigger && onAutoValue) {
        const { drug, sponsor, phase } = data.autoValueTrigger;
        const statusMsg: Message = {
          role: "assistant",
          content: `⏳ Running full valuation for **${drug}**… scanning CT.gov, FDA Orange/Purple Book, patents, and revenue databases. This takes ~20–30 seconds.`,
          isStatus: true,
        };
        setMessages((m) => [...m, statusMsg]);
        setLoading(false);

        const summary = await onAutoValue(drug, sponsor, phase);
        if (summary) {
          setMessages((m) => [...m, {
            role: "assistant",
            content: `✓ ${summary}\n\nWhat would you like to refine? I can adjust assumptions, run scenarios, explain any driver, or dig deeper into the LOE or revenue analysis.`,
          }]);
        }
        return;
      }
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Connection error. Check API key or server logs." }]);
    } finally {
      setLoading(false);
    }
  }

  const quickPrompts = hasAsset
    ? ["What drives rNPV most?", "Explain PTRS", "Bull / base / bear", "Validate LOE"]
    : ["Value pembrolizumab", "Value NXC-201", "Model an orphan drug", "Analyze a CAR-T asset"];

  // Show conversation area only once the user has sent at least one message
  const showMessages = messages.length > 1 || loading;

  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      boxShadow: "var(--shadow-md)",
      marginBottom: 20,
    }}>
      {/* Input row — always visible */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
      }}>
        {/* Label */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "var(--accent)", boxShadow: "0 0 6px var(--accent)",
          }} />
          <span style={{
            fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13,
            color: "var(--text)", whiteSpace: "nowrap",
          }}>
            DrugValue AI
          </span>
        </div>

        {/* Input */}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={hasAsset ? "Ask about this valuation…" : "Type a drug name to get started…"}
          className="input-base"
          style={{ flex: 1, fontSize: 13 }}
        />

        {/* Send */}
        <button
          onClick={() => send()}
          disabled={loading || !input.trim()}
          className="btn btn-primary"
          style={{ padding: "8px 14px", flexShrink: 0 }}
        >
          ↑
        </button>

        {/* Quick prompts — shown inline when no conversation yet */}
        {!showMessages && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {quickPrompts.map((q) => (
              <button key={q} onClick={() => send(q)} style={{
                padding: "4px 10px", fontSize: 11, borderRadius: 20,
                border: "1px solid var(--border)", background: "transparent",
                color: "var(--text-muted)", cursor: "pointer", fontFamily: "var(--font-mono)",
                transition: "all 0.15s", whiteSpace: "nowrap",
              }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-subtle)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages — appear below once conversation starts */}
      {showMessages && (
        <div style={{
          borderTop: "1px solid var(--border)",
          maxHeight: 280, overflowY: "auto",
          padding: "12px 16px",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {messages.map((m, i) => (
            <div key={i}>
              <div style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "80%", padding: "8px 12px",
                  borderRadius: m.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                  background: m.role === "user"
                    ? "var(--accent)"
                    : m.isStatus ? "rgba(30,80,60,0.35)" : "var(--bg-subtle)",
                  color: m.role === "user" ? "var(--accent-fg)" : "var(--text)",
                  fontSize: 13, lineHeight: 1.5, fontFamily: "var(--font-mono)",
                  border: m.role === "assistant"
                    ? `1px solid ${m.isStatus ? "rgba(16,185,129,0.3)" : "var(--border)"}` : "none",
                  whiteSpace: "pre-wrap",
                }}>
                  {m.content}
                </div>
              </div>

              {/* Field update suggestion card */}
              {m.role === "assistant" && m.fieldUpdates && Object.keys(m.fieldUpdates).length > 0 && onFieldUpdate && (
                <div style={{
                  margin: "6px 0 0 0",
                  background: "rgba(5,150,105,0.08)",
                  border: "1px solid rgba(5,150,105,0.3)",
                  borderRadius: 10, padding: "10px 12px",
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Suggested field updates
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                    {Object.entries(m.fieldUpdates).map(([key, val]) => (
                      <div key={key} style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                        <span style={{ color: "var(--text-muted)" }}>{FIELD_LABELS[key] || key}</span>
                        {" → "}
                        <span style={{ fontWeight: 600, color: "#059669" }}>{formatFieldValue(key, val)}</span>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => onFieldUpdate(m.fieldUpdates!)}
                    style={{
                      padding: "5px 14px", fontSize: 12, fontWeight: 700,
                      background: "#059669", color: "#fff",
                      border: "none", borderRadius: 6, cursor: "pointer",
                    }}
                  >
                    Apply ✓
                  </button>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div style={{
                padding: "10px 14px", borderRadius: "12px 12px 12px 2px",
                background: "var(--bg-subtle)", border: "1px solid var(--border)",
                display: "flex", gap: 4, alignItems: "center",
              }}>
                <span className="loading-dot" />
                <span className="loading-dot" />
                <span className="loading-dot" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
};

export default AssistantPanel;
