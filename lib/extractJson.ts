// Robustly extract a JSON object from LLM output. Models routinely wrap the JSON
// in ```json code fences, add a line of prose inside/around it, or leave a
// trailing comma — all of which break a naive JSON.parse and, in an API route,
// surface as an opaque 500. Shared by /api/lead-reasoner and /api/dev-plan.

// Strip code fences, then slice from the first "{" to the last "}" so any prose
// the model wrote around the object ("Here is the plan:") is dropped.
export function extractJsonObject(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

// Repair the most common defect strict JSON.parse rejects: trailing commas
// before a closing brace/bracket. Conservative — does not touch string content,
// so it can't corrupt legitimate text.
export function repairJson(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

// Parse a JSON object out of raw LLM text. Returns the parsed value or null; on
// null, `error` holds the last parse error and `candidate` the text we tried
// (for logging the exact malformation).
export function parseJsonLoose<T = any>(raw: string): { value: T | null; error: string; candidate: string } {
  const candidate = extractJsonObject(raw);
  let error = "";
  for (const attempt of [candidate, repairJson(candidate)]) {
    try { return { value: JSON.parse(attempt) as T, error: "", candidate }; }
    catch (e: any) { error = e?.message || "parse error"; }
  }
  return { value: null, error, candidate };
}
