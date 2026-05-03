import React, { useRef, useState } from "react";

type ToastItem = { id: string; msg: string; type?: "info" | "error" | "success"; duration?: number };

export function useToast() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  function pushToast(msg: string, type: ToastItem["type"] = "info", duration = 4000) {
    const id = String(idRef.current++);
    setItems((cur) => [...cur, { id, msg, type, duration }]);
    if (duration > 0) {
      setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), duration);
    }
  }

  function dismiss(id: string) {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }

  const ToastHost: React.FC = () => (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
      {items.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "10px 14px", borderRadius: 10,
            fontSize: 13, lineHeight: 1.5, fontFamily: "var(--font-mono)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
            background: t.type === "error" ? "#dc2626" : t.type === "success" ? "#16a34a" : "#18181b",
            color: "#fff",
          }}
        >
          <span style={{ flex: 1 }}>{t.msg}</span>
          <button
            onClick={() => dismiss(t.id)}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, marginTop: 1, flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );

  return { pushToast, ToastHost };
}
