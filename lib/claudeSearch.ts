// Shared helper: Claude API call with native web search tool (server-side)
// web_search_20250305 is a server-side tool — Anthropic executes searches
// automatically within a single API call. No manual loop needed.
//
// Optionally pass serperQueries — these are run against Google via Serper.dev
// first, and the results are injected into the prompt before Claude's own search.
// This gives Claude real Google coverage for obscure/newly-announced compounds.

import { serperSearchContext } from "./serperSearch";

export async function callClaudeWithSearch({
  anthropicKey,
  model = "claude-sonnet-4-6",
  system,
  userMessage,
  maxTokens = 2000,
  maxSearches = 5,
  serperQueries,
}: {
  anthropicKey: string;
  model?: string;
  system: string;
  userMessage: string;
  maxTokens?: number;
  maxSearches?: number;
  serperQueries?: string[];
}): Promise<string> {
  // Pre-fetch Google results via Serper if queries provided and key is set
  let googleContext = "";
  const serperKey = process.env.SERPER_API_KEY;
  if (serperQueries && serperQueries.length > 0 && serperKey) {
    googleContext = await serperSearchContext(serperQueries, serperKey).catch(() => "");
    if (googleContext) {
      console.log("[claudeSearch] Serper returned context for", serperQueries.length, "queries");
    }
  }

  const finalUserMessage = googleContext
    ? `${googleContext}\n\n${userMessage}`
    : userMessage;

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
      // Only attach web_search tool if maxSearches > 0 (Haiku does not support it)
      ...(maxSearches > 0 ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }] } : {}),
      messages: [{ role: "user", content: finalUserMessage }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude error ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  const content: any[] = data.content || [];

  // Debug: log stop_reason and content block types to diagnose search issues
  console.log("[claudeSearch] stop_reason:", data.stop_reason, "| content block types:", content.map((c) => c.type).join(", ") || "none");
  if (data.error) console.log("[claudeSearch] API error:", JSON.stringify(data.error));

  // Extract all text blocks from the response
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  return text || "{}";
}
