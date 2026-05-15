// Shared helper: Claude API call with native web search tool (server-side, no Tavily needed)
// Anthropic executes web searches server-side and returns results in the same API response.

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
  const messages: any[] = [{ role: "user", content: userMessage }];

  // Agentic loop: Claude may call web_search multiple times before producing final text
  for (let i = 0; i < 10; i++) {
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
        messages,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Claude error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const content: any[] = data.content || [];

    if (data.stop_reason === "end_turn") {
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") || "{}";
    }

    if (data.stop_reason === "tool_use") {
      // Claude wants to search — add its response to history and continue
      messages.push({ role: "assistant", content });
      const toolResults = content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "" }));
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
      continue;
    }

    // Any other stop reason — return whatever text is present
    return content.filter((c) => c.type === "text").map((c) => c.text).join("") || "{}";
  }

  throw new Error("Claude search loop exceeded max iterations");
}
