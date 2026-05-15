// Shared helper: Claude API call with native web search tool (server-side)
// For web_search_20250305, Anthropic executes searches server-side and embeds
// results in the response content. We just need to pass the full content back
// as the assistant message and continue — no manual tool_result needed.

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

  // Agentic loop: Claude may search multiple times before producing final text.
  // For server-side web_search: Anthropic executes searches and embeds tool_result
  // blocks in the assistant response content. We pass the full content back and continue.
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

    // Extract any text from this response
    const textOutput = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    if (data.stop_reason === "end_turn") {
      return textOutput || "{}";
    }

    if (data.stop_reason === "tool_use") {
      // Add the full assistant content (includes tool_use + any embedded tool_result blocks)
      messages.push({ role: "assistant", content });

      // For server-side tools, Anthropic embeds tool_result blocks in the content.
      // Extract them to pass back as the user turn so the API alternation is satisfied.
      const toolResultBlocks = content.filter((c) => c.type === "tool_result");
      if (toolResultBlocks.length > 0) {
        // Server already provided results — pass them back as user turn
        messages.push({ role: "user", content: toolResultBlocks });
      } else {
        // No embedded results yet — send minimal acknowledgment to satisfy alternation
        const toolUseIds = content
          .filter((c) => c.type === "tool_use")
          .map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Search executed." }));
        if (toolUseIds.length > 0) {
          messages.push({ role: "user", content: toolUseIds });
        }
      }
      continue;
    }

    // Any other stop reason — return whatever text is present
    return textOutput || "{}";
  }

  throw new Error("Claude search loop exceeded max iterations");
}
