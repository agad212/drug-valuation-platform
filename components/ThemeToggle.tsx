import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ width: 32, height: 32 }} />;

  const isDark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      style={{
        width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border)",
        background: "transparent", cursor: "pointer", display: "flex",
        alignItems: "center", justifyContent: "center", fontSize: 14,
        color: "var(--text-muted)", transition: "all 0.15s",
      }}
      title={isDark ? "Switch to light" : "Switch to dark"}
    >
      {isDark ? "☀" : "◑"}
    </button>
  );
}
