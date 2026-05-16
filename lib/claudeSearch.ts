// Shared helper: Claude API call with native web search tool (server-side)
// web_search_20250305 is a server-side tool — Anthropic executes searches
// automatically within a single API call. No manual loop needed.

export async function callClaudeWithSearch({
  anthropicKey,
  model = "claude-haiku-4-5-20251001",
  system,
  userMessage,
  maxTokens = 2000,
  maxSearches = 5,
}: {
  anthropicKey: string;
  model?: string;
  system: string;
  userMessage: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude error ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  const content: any[] = data.content || [];

  // Extract all text blocks from the response
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  return text || "{}";
}
