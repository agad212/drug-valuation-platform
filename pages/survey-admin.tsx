import { useEffect, useState } from "react";
import Head from "next/head";
import { SEGMENTS, QUESTIONS_BY_SEGMENT, DEFAULT_SEGMENT, isSegmentId, type SegmentId } from "../lib/survey-questions";

type SurveyResponse = { id: string; createdAt: string; segment?: SegmentId; answers: Record<string, string> };

const KEY_STORE = "rd-survey-admin-key";

function segmentOf(r: SurveyResponse): SegmentId {
  return isSegmentId(r.segment) ? r.segment : DEFAULT_SEGMENT;
}

// ─── Minimal markdown → HTML (headings, lists, tables, bold, code) ────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function mdToHtml(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join("") + `</${list.type}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table block
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      flushList();
      const parseRow = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
      const header = parseRow(line);
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        body.push(parseRow(lines[j]));
        j++;
      }
      out.push(
        `<div class="tbl-wrap"><table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`
      );
      i = j - 1;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(h[1].length + 1, 5); // page h1 is taken; shift down
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)![1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join("\n");
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SurveyAdminPage() {
  const [key, setKey] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [analysis, setAnalysis] = useState("");
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) {
      setKey(saved);
      void load(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function lock() {
    localStorage.removeItem(KEY_STORE);
    setKey("");
    setUnlocked(false);
    setResponses([]);
    setAnalysis("");
    setError("");
  }

  async function load(k: string) {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/survey/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminKey: k }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || "Could not load responses.");
        setUnlocked(false);
        localStorage.removeItem(KEY_STORE);
        return;
      }
      setResponses(data.responses || []);
      setUnlocked(true);
      localStorage.setItem(KEY_STORE, k);
    } catch {
      setError("Network error — try again.");
    } finally {
      setLoading(false);
    }
  }

  async function runAnalysis() {
    setAnalyzing(true);
    setError("");
    try {
      const r = await fetch("/api/survey/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminKey: key }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || "Analysis failed.");
        return;
      }
      setAnalysis(data.analysis || "");
    } catch {
      setError("Network error during analysis — try again.");
    } finally {
      setAnalyzing(false);
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(responses, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `survey-responses-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rdadm">
      <Head>
        <title>Survey Results — Admin</title>
        <meta name="robots" content="noindex" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="wrap">
        <span className="eyebrow">Owner view</span>
        <h1>Survey results</h1>

        {!unlocked ? (
          <div className="panel unlock">
            <p>Enter the access key to view responses and run AI analysis.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void load(key.trim());
              }}
            >
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Access key"
                autoFocus
              />
              <button type="submit" className="btn-primary" disabled={loading || !key.trim()}>
                {loading ? "Checking…" : "Unlock"}
              </button>
            </form>
            {error ? <p className="error">{error}</p> : null}
          </div>
        ) : (
          <>
            <div className="toolbar">
              <span className="count">
                {responses.length} response{responses.length === 1 ? "" : "s"}
              </span>
              <div className="toolbar-btns">
                <button className="btn-secondary" onClick={lock} title="Forget the key on this device">
                  Lock
                </button>
                <button className="btn-secondary" onClick={() => void load(key)} disabled={loading}>
                  {loading ? "Refreshing…" : "Refresh"}
                </button>
                <button className="btn-secondary" onClick={downloadJson} disabled={responses.length === 0}>
                  Download JSON
                </button>
                <button className="btn-primary" onClick={() => void runAnalysis()} disabled={analyzing || responses.length === 0}>
                  {analyzing ? "Analyzing… (can take a minute)" : "Analyze with AI"}
                </button>
              </div>
            </div>
            {error ? <p className="error">{error}</p> : null}

            {analysis ? (
              <div className="panel analysis">
                <div className="analysis-head">
                  <h2>AI analysis</h2>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(analysis);
                    }}
                  >
                    Copy markdown
                  </button>
                </div>
                <div className="analysis-body" dangerouslySetInnerHTML={{ __html: mdToHtml(analysis) }} />
              </div>
            ) : null}

            {responses.length === 0 && !loading ? (
              <p className="empty">No responses yet. Share the survey link and check back.</p>
            ) : null}

            {SEGMENTS.map((seg) => {
              const segResponses = responses.filter((r) => segmentOf(r) === seg.id);
              return (
                <section key={seg.id} className="seg-section">
                  <div className="seg-head">
                    <h2>{seg.label}</h2>
                    <span className="seg-product">{seg.product} product</span>
                    <span className="seg-count">
                      {segResponses.length} response{segResponses.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {segResponses.length === 0 ? (
                    <p className="empty seg-empty">None yet.</p>
                  ) : (
                    segResponses.map((r, idx) => {
                      const n = segResponses.length - idx; // newest first → highest number
                      const who =
                        r.answers.q0 ||
                        [r.answers.a_role, r.answers.a_level, r.answers.a_org].filter(Boolean).join(" · ") ||
                        "Anonymous";
                      const open = !!expanded[r.id];
                      const questions = QUESTIONS_BY_SEGMENT[seg.id];
                      return (
                        <div className="panel resp" key={r.id}>
                          <button className="resp-head" onClick={() => setExpanded((p) => ({ ...p, [r.id]: !open }))}>
                            <span className="resp-tag">{seg.tagPrefix}{n}</span>
                            <span className="resp-who">{who}</span>
                            <span className="resp-date">{r.createdAt.slice(0, 10)}</span>
                            <span className="resp-caret">{open ? "▾" : "▸"}</span>
                          </button>
                          {open ? (
                            <dl className="resp-body">
                              {questions.filter((q) => r.answers[q.id]).map((q) => (
                                <div key={q.id} className="qa">
                                  <dt>{q.short}</dt>
                                  <dd>
                                    {q.kind === "scale"
                                      ? `${r.answers[q.id]}/5` +
                                        (q.stepLabels
                                          ? ` — ${q.stepLabels[Number(r.answers[q.id]) - 1] || ""}`
                                          : q.anchors
                                          ? ` (1=${q.anchors.min}, 5=${q.anchors.max})`
                                          : "")
                                      : r.answers[q.id]}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </section>
              );
            })}
          </>
        )}
      </main>

      <style jsx global>{`
        .rdadm {
          --accent: #156f71;
          --accent-soft: rgba(21, 111, 113, 0.12);
          --ink: #182a2f;
          --muted: #5b6e73;
          --ground: #f6f8f8;
          --surface: #ffffff;
          --line: #d8e0e1;
          --focus: #1e8a8c;
          --danger: #b3423a;
          min-height: 100vh;
          background: var(--ground);
          color: var(--ink);
          font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          line-height: 1.55;
        }
        @media (prefers-color-scheme: dark) {
          .rdadm {
            --accent: #4fb3b5;
            --accent-soft: rgba(79, 179, 181, 0.14);
            --ink: #e4eced;
            --muted: #93a6aa;
            --ground: #0f1b1e;
            --surface: #16262b;
            --line: #2b3f44;
            --focus: #63c4c6;
            --danger: #e08a84;
          }
        }
        html.dark .rdadm {
          --accent: #4fb3b5;
          --accent-soft: rgba(79, 179, 181, 0.14);
          --ink: #e4eced;
          --muted: #93a6aa;
          --ground: #0f1b1e;
          --surface: #16262b;
          --line: #2b3f44;
          --focus: #63c4c6;
          --danger: #e08a84;
        }
        html.light .rdadm {
          --accent: #156f71;
          --accent-soft: rgba(21, 111, 113, 0.12);
          --ink: #182a2f;
          --muted: #5b6e73;
          --ground: #f6f8f8;
          --surface: #ffffff;
          --line: #d8e0e1;
          --focus: #1e8a8c;
          --danger: #b3423a;
        }

        .rdadm .wrap { max-width: 860px; margin: 0 auto; padding: 48px 20px 96px; }
        .rdadm .eyebrow {
          font-size: 0.75rem; font-weight: 600; letter-spacing: 0.14em;
          text-transform: uppercase; color: var(--accent);
        }
        .rdadm h1, .rdadm h2 {
          font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
          font-weight: 700; line-height: 1.2; margin: 10px 0 18px;
        }
        .rdadm h1 { font-size: clamp(1.6rem, 4vw, 2rem); }
        .rdadm h2 { font-size: 1.3rem; margin: 0; }

        .rdadm .panel {
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 20px;
          margin-top: 16px;
        }
        .rdadm .unlock p { color: var(--muted); margin: 0 0 14px; }
        .rdadm .unlock form { display: flex; gap: 10px; flex-wrap: wrap; }
        .rdadm input[type="password"] {
          flex: 1 1 220px;
          background: var(--ground);
          color: var(--ink);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 11px 14px;
          font: inherit;
        }
        .rdadm input:focus-visible, .rdadm button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

        .rdadm button { font: inherit; font-weight: 600; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
        .rdadm .btn-primary { background: var(--accent); color: var(--ground); border: none; }
        .rdadm .btn-primary:hover { filter: brightness(1.08); }
        .rdadm .btn-primary:disabled { opacity: 0.6; cursor: default; }
        .rdadm .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
        .rdadm .btn-secondary:hover { background: var(--accent-soft); }
        .rdadm .btn-secondary:disabled { opacity: 0.5; cursor: default; }

        .rdadm .toolbar {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; flex-wrap: wrap; margin-top: 8px;
        }
        .rdadm .count { color: var(--muted); font-weight: 600; }
        .rdadm .toolbar-btns { display: flex; gap: 8px; flex-wrap: wrap; }

        .rdadm .error { color: var(--danger); font-size: 0.92rem; margin: 10px 0 0; }
        .rdadm .empty { color: var(--muted); margin-top: 24px; }

        .rdadm .seg-section { margin-top: 36px; }
        .rdadm .seg-head {
          display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
          padding-bottom: 8px; border-bottom: 2px solid var(--accent);
        }
        .rdadm .seg-head h2 { font-size: 1.15rem; }
        .rdadm .seg-product {
          font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--accent); background: var(--accent-soft); border-radius: 6px; padding: 2px 8px;
        }
        .rdadm .seg-count { margin-left: auto; color: var(--muted); font-size: 0.88rem; }
        .rdadm .seg-empty { margin-top: 12px; font-size: 0.92rem; }

        .rdadm .resp { padding: 0; overflow: hidden; }
        .rdadm .resp-head {
          display: flex; align-items: center; gap: 12px;
          width: 100%; text-align: left;
          background: none; border: none; padding: 14px 18px;
          color: var(--ink); font-weight: 600;
        }
        .rdadm .resp-head:hover { background: var(--accent-soft); }
        .rdadm .resp-tag {
          background: var(--accent-soft); color: var(--accent);
          border-radius: 6px; padding: 2px 8px; font-size: 0.8rem; flex: none;
        }
        .rdadm .resp-who { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rdadm .resp-date { color: var(--muted); font-weight: 400; font-size: 0.85rem; flex: none; }
        .rdadm .resp-caret { color: var(--muted); flex: none; }
        .rdadm .resp-body { margin: 0; padding: 4px 18px 16px; border-top: 1px solid var(--line); }
        .rdadm .qa { margin-top: 12px; }
        .rdadm .qa dt { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
        .rdadm .qa dd { margin: 4px 0 0; white-space: pre-wrap; }

        .rdadm .analysis-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .rdadm .analysis-body h2, .rdadm .analysis-body h3, .rdadm .analysis-body h4 {
          font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
          margin: 20px 0 8px;
        }
        .rdadm .analysis-body h2 { font-size: 1.25rem; }
        .rdadm .analysis-body h3 { font-size: 1.1rem; }
        .rdadm .analysis-body p { margin: 8px 0; }
        .rdadm .analysis-body ul, .rdadm .analysis-body ol { margin: 8px 0; padding-left: 22px; }
        .rdadm .analysis-body li { margin: 4px 0; }
        .rdadm .analysis-body code {
          background: var(--accent-soft); border-radius: 4px; padding: 1px 5px; font-size: 0.9em;
        }
        .rdadm .tbl-wrap { overflow-x: auto; margin: 12px 0; }
        .rdadm table { border-collapse: collapse; font-size: 0.9rem; min-width: 100%; }
        .rdadm th, .rdadm td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
        .rdadm th { background: var(--accent-soft); }
      `}</style>
    </div>
  );
}
