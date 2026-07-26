import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import {
  SEGMENTS,
  QUESTIONS_BY_SEGMENT,
  CONCEPT_BY_SEGMENT,
  progressIds,
  numberingFor,
  isSegmentId,
  type SegmentId,
  type SurveyQuestion,
} from "../lib/survey-questions";

const STORE_KEY = "rd-survey-v3";
const MULTI_SEP = "; ";
const REQUIRED_INTRO_IDS = ["a_role", "a_org", "a_level"];

type Status = "idle" | "sending" | "done" | "error";
type AnswerMap = Record<string, string>;

export default function SurveyPage() {
  const [segment, setSegment] = useState<SegmentId | "">("");
  const [answersBySegment, setAnswersBySegment] = useState<Partial<Record<SegmentId, AnswerMap>>>({});
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const answers: AnswerMap = (segment && answersBySegment[segment]) || {};

  // Restore autosaved state
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (saved && typeof saved === "object") {
        if (isSegmentId(saved.segment)) setSegment(saved.segment);
        if (saved.answersBySegment && typeof saved.answersBySegment === "object") {
          setAnswersBySegment(saved.answersBySegment);
        }
      }
    } catch {
      /* private mode — continue without persistence */
    }
  }, []);

  function persist(seg: SegmentId | "", all: Partial<Record<SegmentId, AnswerMap>>) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ segment: seg, answersBySegment: all }));
    } catch {
      /* ignore */
    }
  }

  function pickSegment(value: string) {
    const seg = isSegmentId(value) ? value : "";
    setSegment(seg);
    setStatus("idle");
    setErrorMsg("");
    persist(seg, answersBySegment);
  }

  function setAnswer(id: string, value: string) {
    if (!segment) return;
    setAnswersBySegment((prev) => {
      const segAnswers = { ...(prev[segment] || {}) };
      if (value) segAnswers[id] = value;
      else delete segAnswers[id];
      const next = { ...prev, [segment]: segAnswers };
      persist(segment, next);
      return next;
    });
  }

  function toggleMulti(id: string, choice: string) {
    const current = (answers[id] || "").split(MULTI_SEP).filter(Boolean);
    const next = current.includes(choice) ? current.filter((c) => c !== choice) : [...current, choice];
    setAnswer(id, next.join(MULTI_SEP));
  }

  const progress = useMemo(() => {
    if (!segment) return 0;
    const ids = progressIds(segment);
    const answered = ids.filter((id) => (answers[id] || "").trim()).length;
    return Math.round((answered / ids.length) * 100);
  }, [segment, answers]);

  const hasAny = useMemo(() => Object.values(answers).some((v) => (v || "").trim()), [answers]);

  async function submit() {
    if (!segment) return;
    if (!hasAny) {
      setErrorMsg("Please answer at least one question first.");
      setStatus("error");
      return;
    }
    const missing = REQUIRED_INTRO_IDS.find((id) => !(answers[id] || "").trim());
    if (missing) {
      setErrorMsg("Please fill in the three quick questions about you at the top — they're fully anonymous.");
      setStatus("error");
      const el = document.getElementById(`${missing}-label`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setStatus("sending");
    setErrorMsg("");
    try {
      const r = await fetch("/api/survey/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment, answers }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErrorMsg(data.error || "Something went wrong — please try again.");
        setStatus("error");
        return;
      }
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {
        /* ignore */
      }
      setStatus("done");
      window.scrollTo({ top: 0 });
    } catch {
      setErrorMsg("Network error — your answers are still saved in this browser. Please try again.");
      setStatus("error");
    }
  }

  const numbering = segment ? numberingFor(segment) : {};

  function renderQuestion(q: SurveyQuestion) {
    const num = numbering[q.id];
    const labelBlock = (
      <span className="q-label" id={`${q.id}-label`}>
        {num ? <span className="q-num">{num}.</span> : null}
        {q.label}
        {q.optional ? <span className="optional-tag">Optional</span> : null}
        {q.hint ? <span className="q-hint">{q.hint}</span> : null}
      </span>
    );

    if (q.kind === "scale") {
      const selected = answers[q.id] || "";
      return (
        <div className="question" key={q.id}>
          {labelBlock}
          <div className="scale-row" role="radiogroup" aria-labelledby={`${q.id}-label`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                type="button"
                key={n}
                className={"scale-dot" + (selected === String(n) ? " selected" : "")}
                aria-pressed={selected === String(n)}
                onClick={() => setAnswer(q.id, String(n))}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="scale-anchors">
            <span>{q.anchors?.min}</span>
            <span>{q.anchors?.max}</span>
          </div>
          {q.stepLabels && selected ? <div className="scale-current">{q.stepLabels[Number(selected) - 1]}</div> : null}
        </div>
      );
    }

    if (q.kind === "multi") {
      const selected = (answers[q.id] || "").split(MULTI_SEP).filter(Boolean);
      return (
        <div className="question" key={q.id}>
          {labelBlock}
          <span className="q-hint" style={{ marginTop: -6, marginBottom: 8, display: "block" }}>
            Select all that apply.
          </span>
          <div className="choices" role="group" aria-labelledby={`${q.id}-label`}>
            {(q.choices || []).map((c) => (
              <label className={"choice" + (selected.includes(c) ? " selected" : "")} key={c}>
                <input type="checkbox" checked={selected.includes(c)} onChange={() => toggleMulti(q.id, c)} />
                {c}
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (q.kind === "choice") {
      return (
        <div className="question" key={q.id}>
          {labelBlock}
          <div className="choices" role="radiogroup" aria-labelledby={`${q.id}-label`}>
            {(q.choices || []).map((c) => (
              <label className={"choice" + (answers[q.id] === c ? " selected" : "")} key={c}>
                <input
                  type="radio"
                  name={q.id}
                  value={c}
                  checked={answers[q.id] === c}
                  onChange={() => setAnswer(q.id, c)}
                />
                {c}
              </label>
            ))}
          </div>
        </div>
      );
    }

    const shared = { id: q.id, value: answers[q.id] || "", placeholder: q.placeholder || "" };
    return (
      <div className="question" key={q.id}>
        <label className="q-label" htmlFor={q.id}>
          {num ? <span className="q-num">{num}.</span> : null}
          {q.label}
          {q.optional ? <span className="optional-tag">Optional</span> : null}
          {q.hint ? <span className="q-hint">{q.hint}</span> : null}
        </label>
        {q.kind === "text" ? (
          <input type="text" {...shared} onChange={(e) => setAnswer(q.id, e.target.value)} />
        ) : (
          <textarea {...shared} onChange={(e) => setAnswer(q.id, e.target.value)} />
        )}
      </div>
    );
  }

  const qs = segment ? QUESTIONS_BY_SEGMENT[segment] : [];
  const intro = qs.filter((q) => q.part === 0);
  const part1 = qs.filter((q) => q.part === 1);
  const part2 = qs.filter((q) => q.part === 2);
  const concept = segment ? CONCEPT_BY_SEGMENT[segment] : [];

  return (
    <div className="rdsvy">
      <Head>
        <title>Biopharma R&amp;D Decision Survey</title>
        <meta name="robots" content="noindex" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <main className="wrap">
        {status === "done" ? (
          <div className="thanks">
            <h1>Thank you.</h1>
            <p>
              Your answers are in — genuinely appreciated. If you thought of someone else I should speak with, feel
              free to pass this link along.
            </p>
          </div>
        ) : (
          <>
            <span className="eyebrow">Research survey &middot; ~2 minutes</span>
            <h1>How biopharma teams and investors make value-driven decisions</h1>
            <p className="intro">
              Thanks for your time. <strong>I&rsquo;m not pitching anything</strong> — I&rsquo;m researching how
              biopharma teams and their investors make high-stakes decisions where a drug asset&rsquo;s risk-adjusted
              value drives the call, and where that process breaks down today.
            </p>

            <div className="privacy-note">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>
                <strong>No question asks about specific assets, programs, or numbers</strong> — everything is
                answerable in general terms.
              </span>
            </div>

            <div className="question">
              <label className="q-label" htmlFor="segment">
                First — which best describes you?
              </label>
              <select id="segment" value={segment} onChange={(e) => pickSegment(e.target.value)}>
                <option value="" disabled>
                  Select one…
                </option>
                {SEGMENTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {segment ? (
              <>
                {intro.map(renderQuestion)}

                <div className="part-header">
                  <span className="eyebrow">Part 1 &middot; About 1 minute</span>
                  <h2>How these decisions happen today</h2>
                  <p>In general terms only — nothing about specific assets or programs.</p>
                </div>
                {part1.map(renderQuestion)}

                <div className="part-header">
                  <span className="eyebrow">Part 2 &middot; About 1 minute</span>
                  <h2>Concept fit</h2>
                  <p>Quick context on what I&rsquo;m building, then a few questions.</p>
                </div>
                <div className="concept">
                  {concept.map((t, i) => (
                    <p key={i}>{t}</p>
                  ))}
                </div>
                {part2.map(renderQuestion)}

                <div className="send-panel">
                  <h2>Submit your answers</h2>
                  <p>Answers go straight to the researcher — nothing else is collected.</p>
                  <button type="button" className="btn-primary" onClick={submit} disabled={status === "sending"}>
                    {status === "sending" ? "Submitting…" : "Submit answers"}
                  </button>
                  <div className="status-line" role="status" aria-live="polite">
                    {status === "error" ? errorMsg : ""}
                  </div>
                </div>

                <p className="autosave-note">
                  Your answers save automatically in this browser, so you can leave and come back.
                </p>
              </>
            ) : null}
          </>
        )}
      </main>

      <style jsx global>{`
        .rdsvy {
          --accent: #156f71;
          --accent-soft: rgba(21, 111, 113, 0.12);
          --ink: #182a2f;
          --muted: #5b6e73;
          --ground: #f6f8f8;
          --surface: #ffffff;
          --line: #d8e0e1;
          --focus: #1e8a8c;
          min-height: 100vh;
          background: var(--ground);
          color: var(--ink);
          font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          line-height: 1.55;
        }
        @media (prefers-color-scheme: dark) {
          .rdsvy {
            --accent: #4fb3b5;
            --accent-soft: rgba(79, 179, 181, 0.14);
            --ink: #e4eced;
            --muted: #93a6aa;
            --ground: #0f1b1e;
            --surface: #16262b;
            --line: #2b3f44;
            --focus: #63c4c6;
          }
        }
        html.dark .rdsvy {
          --accent: #4fb3b5;
          --accent-soft: rgba(79, 179, 181, 0.14);
          --ink: #e4eced;
          --muted: #93a6aa;
          --ground: #0f1b1e;
          --surface: #16262b;
          --line: #2b3f44;
          --focus: #63c4c6;
        }
        html.light .rdsvy {
          --accent: #156f71;
          --accent-soft: rgba(21, 111, 113, 0.12);
          --ink: #182a2f;
          --muted: #5b6e73;
          --ground: #f6f8f8;
          --surface: #ffffff;
          --line: #d8e0e1;
          --focus: #1e8a8c;
        }

        .rdsvy .progress-track {
          position: fixed;
          top: 0; left: 0; right: 0;
          height: 4px;
          background: var(--line);
          z-index: 10;
        }
        .rdsvy .progress-fill {
          height: 100%;
          background: var(--accent);
          transition: width 0.35s ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .rdsvy .progress-fill { transition: none; }
        }

        .rdsvy .wrap {
          max-width: 640px;
          margin: 0 auto;
          padding: 48px 20px 96px;
        }
        .rdsvy .eyebrow {
          font-size: 0.75rem;
          font-weight: 600;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--accent);
        }
        .rdsvy h1 {
          font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
          font-size: clamp(1.7rem, 5vw, 2.3rem);
          font-weight: 700;
          line-height: 1.2;
          margin: 10px 0 18px;
          text-wrap: balance;
        }
        .rdsvy .intro { color: var(--muted); font-size: 1rem; margin: 0 0 10px; }
        .rdsvy .intro strong { color: var(--ink); font-weight: 600; }

        .rdsvy .privacy-note {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          background: var(--accent-soft);
          border-radius: 8px;
          padding: 12px 14px;
          margin: 22px 0 0;
          font-size: 0.9rem;
        }
        .rdsvy .privacy-note svg { flex: none; margin-top: 2px; }

        .rdsvy .part-header {
          margin: 56px 0 8px;
          padding-top: 28px;
          border-top: 1px solid var(--line);
        }
        .rdsvy .part-header h2, .rdsvy .send-panel h2 {
          font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
          font-size: 1.35rem;
          font-weight: 700;
          margin: 8px 0 6px;
        }
        .rdsvy .part-header p { color: var(--muted); font-size: 0.95rem; margin: 0; }

        .rdsvy .concept {
          background: var(--surface);
          border: 1px solid var(--line);
          border-left: 3px solid var(--accent);
          border-radius: 8px;
          padding: 16px 18px;
          margin: 20px 0 0;
          font-size: 0.95rem;
        }
        .rdsvy .concept p { margin: 0 0 10px; }
        .rdsvy .concept p:last-child { margin-bottom: 0; }

        .rdsvy .question { margin: 34px 0 0; }
        .rdsvy .q-label { display: block; font-weight: 600; font-size: 1rem; margin-bottom: 10px; }
        .rdsvy .q-num { color: var(--accent); font-weight: 700; margin-right: 6px; }
        .rdsvy .q-hint { display: block; font-weight: 400; color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
        .rdsvy .optional-tag {
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          margin-left: 8px;
        }

        .rdsvy textarea, .rdsvy input[type="text"], .rdsvy select {
          width: 100%;
          background: var(--surface);
          color: var(--ink);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 12px 14px;
          font: inherit;
          font-size: 1rem;
        }
        .rdsvy textarea { min-height: 84px; resize: vertical; }
        .rdsvy select { appearance: auto; cursor: pointer; }
        .rdsvy textarea:focus-visible, .rdsvy input:focus-visible, .rdsvy select:focus-visible, .rdsvy button:focus-visible {
          outline: 2px solid var(--focus);
          outline-offset: 2px;
        }
        .rdsvy ::placeholder { color: var(--muted); opacity: 0.7; }

        .rdsvy .choices { display: flex; flex-direction: column; gap: 8px; }
        .rdsvy .choice {
          display: flex;
          align-items: center;
          gap: 10px;
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 11px 14px;
          cursor: pointer;
          font-size: 0.95rem;
        }
        .rdsvy .choice.selected { border-color: var(--accent); background: var(--accent-soft); }
        .rdsvy .choice input { accent-color: var(--accent); width: 18px; height: 18px; margin: 0; flex: none; }

        .rdsvy .scale-row { display: flex; gap: 8px; }
        .rdsvy .scale-dot {
          flex: 1 1 0;
          padding: 12px 0;
          font: inherit;
          font-weight: 600;
          font-size: 1rem;
          background: var(--surface);
          color: var(--ink);
          border: 1px solid var(--line);
          border-radius: 8px;
          cursor: pointer;
        }
        .rdsvy .scale-dot.selected {
          background: var(--accent);
          border-color: var(--accent);
          color: var(--ground);
        }
        .rdsvy .scale-anchors {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: 6px;
          color: var(--muted);
          font-size: 0.8rem;
        }
        .rdsvy .scale-anchors span:last-child { text-align: right; }
        .rdsvy .scale-current {
          margin-top: 6px;
          text-align: center;
          color: var(--accent);
          font-size: 0.9rem;
          font-weight: 600;
        }

        .rdsvy .send-panel {
          margin-top: 64px;
          padding: 24px;
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 10px;
        }
        .rdsvy .send-panel p { color: var(--muted); font-size: 0.92rem; margin: 0 0 18px; }
        .rdsvy .btn-primary {
          font: inherit;
          font-weight: 600;
          border-radius: 8px;
          padding: 12px 20px;
          cursor: pointer;
          border: none;
          background: var(--accent);
          color: var(--ground);
          width: 100%;
        }
        .rdsvy .btn-primary:hover { filter: brightness(1.08); }
        .rdsvy .btn-primary:disabled { opacity: 0.6; cursor: default; }
        .rdsvy .status-line { margin-top: 12px; font-size: 0.92rem; color: var(--muted); min-height: 1.4em; }

        .rdsvy .autosave-note { text-align: center; color: var(--muted); font-size: 0.82rem; margin-top: 28px; }

        .rdsvy .thanks { text-align: center; padding-top: 15vh; }
        .rdsvy .thanks p { color: var(--muted); max-width: 42ch; margin: 0 auto; }
      `}</style>
    </div>
  );
}
