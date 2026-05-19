// Serper.dev — Google Search API helper
// Returns Google results to inject as context before Claude's own search.

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
}

export async function serperSearch(
  query: string,
  apiKey: string,
  numResults = 6
): Promise<SerperResult[]> {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: numResults }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.organic || []).slice(0, numResults).map((r: any) => ({
      title: r.title || "",
      link: r.link || "",
      snippet: r.snippet || "",
      date: r.date,
    }));
  } catch {
    return [];
  }
}

// Run multiple queries in parallel and format results as a context block
// to inject into the Claude prompt before calling the API.
export async function serperSearchContext(
  queries: string[],
  apiKey: string,
  numPerQuery = 4
): Promise<string> {
  const allResults = await Promise.all(
    queries.map((q) => serperSearch(q, apiKey, numPerQuery).catch(() => [] as SerperResult[]))
  );

  const lines: string[] = [];
  allResults.forEach((results, i) => {
    if (results.length === 0) return;
    lines.push(`\n[Google: "${queries[i]}"]`);
    results.forEach((r) => {
      lines.push(`• ${r.title}`);
      lines.push(`  ${r.link}`);
      lines.push(`  ${r.snippet}`);
    });
  });

  if (lines.length === 0) return "";
  return `\n\n=== GOOGLE SEARCH RESULTS (use these as primary sources) ===\n${lines.join("\n")}\n=== END GOOGLE RESULTS ===\n`;
}
