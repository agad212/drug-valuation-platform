/**
 * LOE adapter — scrapes patent & exclusivity dates from the FDA Orange Book search page.
 * Falls back to a default estimate if the drug is not found or not in the Orange Book.
 * Note: Biologics (BLA) are in the Purple Book, not the Orange Book.
 */

// ─── Step 1: Find the FDA application number via openFDA ─────────────────────

async function fetchOpenFDAApp(
  drugName: string
): Promise<{ appType: string; appNo: string; appLabel: string; isBiologic: boolean } | null> {
  const nameLower = drugName.toLowerCase();

  // ── Primary: drugsfda API (reliable for BLA/NDA, works for biologics) ──────
  for (const field of ["openfda.generic_name", "openfda.brand_name"]) {
    try {
      const url = `https://api.fda.gov/drug/drugsfda.json?search=${field}:"${encodeURIComponent(drugName)}"&limit=1`;
      const res = await fetchWithTimeout(url, 6000);
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.results?.[0];
      if (!result) continue;
      const appNum: string = result.application_number || "";
      if (!appNum) continue;
      const match = appNum.match(/^(NDA|ANDA|BLA)(\d+)$/);
      if (!match) continue;
      // Validate name
      const openfdaGeneric = ((result.openfda?.generic_name || [])[0] || "").toLowerCase();
      const openfdaBrand  = ((result.openfda?.brand_name  || [])[0] || "").toLowerCase();
      const nameMatch =
        openfdaGeneric.includes(nameLower) || nameLower.includes(openfdaGeneric.split(" ")[0]) ||
        openfdaBrand.includes(nameLower)   || nameLower.includes(openfdaBrand.split(" ")[0]);
      if (!nameMatch) continue;
      const prefix = match[1];
      const rawNo  = match[2];
      const isBiologic = prefix === "BLA";
      const appType = prefix === "ANDA" ? "A" : "N";
      const appNo = rawNo.replace(/^0+/, "");
      return { appType, appNo, appLabel: `${prefix}${rawNo}`, isBiologic };
    } catch { continue; }
  }

  // ── Fallback: NDC API ────────────────────────────────────────────────────────
  const nameUpper = drugName.toUpperCase();
  for (const field of ["brand_name", "generic_name"]) {
    try {
      const url = `https://api.fda.gov/drug/ndc.json?search=${field}:${encodeURIComponent(nameUpper)}&limit=1`;
      const res = await fetchWithTimeout(url, 6000);
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.results?.[0];
      if (!result) continue;

      const returnedBrand   = (result.brand_name   || "").toLowerCase();
      const returnedGeneric = (result.generic_name || "").toLowerCase();
      const nameMatch =
        returnedBrand.includes(nameLower)   || nameLower.includes(returnedBrand.split(" ")[0]) ||
        returnedGeneric.includes(nameLower) || nameLower.includes(returnedGeneric.split(" ")[0]);
      if (!nameMatch) continue;

      const appNum: string = result.application_number || "";
      if (!appNum) continue;
      const match = appNum.match(/^(NDA|ANDA|BLA)(\d+)$/);
      if (!match) continue;
      const prefix = match[1];
      const rawNo  = match[2];
      const isBiologic = prefix === "BLA";
      const appType = prefix === "ANDA" ? "A" : "N";
      const appNo = rawNo.replace(/^0+/, "");
      return { appType, appNo, appLabel: `${prefix}${rawNo}`, isBiologic };
    } catch { continue; }
  }

  return null;
}

// ─── Step 2a: Biologic LOE via BPCIA 12-year exclusivity ─────────────────────
// Biologics get 12 years data exclusivity from first FDA approval (BPCIA).
// Get approval date from openFDA submissions.

async function inferBiologicLOE(appLabel: string, appNo: string): Promise<{
  loeDate: string | null;
  reasons: string[];
  sources: { label: string; url?: string }[];
}> {
  const fallbackYear = new Date().getFullYear() + 8;
  const purpleBookUrl = `https://purplebooksearch.fda.gov/`;

  try {
    const url = `https://api.fda.gov/drug/drugsfda.json?search=application_number:"${appLabel}"&limit=1`;
    const res = await fetchWithTimeout(url, 6000);
    if (!res.ok) throw new Error("openFDA not found");
    const data = await res.json();
    const submissions: any[] = data?.results?.[0]?.submissions || [];

    // Find the earliest "AP" (Approval) action date
    const approvalDates = submissions
      .filter((s: any) => s.submission_status === "AP" && s.submission_status_date)
      .map((s: any) => new Date(s.submission_status_date))
      .filter((d: Date) => !isNaN(d.getTime()));

    if (approvalDates.length === 0) throw new Error("No approval date found");

    const firstApproval = new Date(Math.min(...approvalDates.map((d) => d.getTime())));
    const exclusivityExpiry = new Date(firstApproval);
    exclusivityExpiry.setFullYear(exclusivityExpiry.getFullYear() + 12);
    const loeDate = exclusivityExpiry.toISOString().slice(0, 10);

    return {
      loeDate,
      reasons: [
        `${appLabel} is a biologic. First FDA approval: ${firstApproval.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`,
        `BPCIA grants 12 years of reference product exclusivity. Exclusivity expires: ${exclusivityExpiry.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`,
        `Note: Patent expiries may extend market protection beyond this date.`,
      ],
      sources: [
        { label: `FDA Purple Book — ${appLabel}`, url: purpleBookUrl },
        { label: "BPCIA 12-year exclusivity (42 U.S.C. § 262(k)(7))" },
      ],
    };
  } catch {
    return {
      loeDate: `${fallbackYear}-12-31`,
      reasons: [
        `${appLabel} is a biologic (BLA). Could not retrieve approval date from FDA.`,
        `Using default estimate (+8 years). Check the FDA Purple Book for accurate exclusivity data.`,
      ],
      sources: [{ label: `FDA Purple Book — ${appLabel}`, url: purpleBookUrl }],
    };
  }
}

// ─── Step 2b: Scrape Orange Book results page for this application ─────────────
// URL: https://www.accessdata.fda.gov/scripts/cder/ob/results_product.cfm?Appl_Type=N&Appl_No=202155

async function scrapeOrangeBookDates(
  appType: string,
  appNo: string
): Promise<{ dates: Date[]; debug: string }> {
  const baseUrl = "https://www.accessdata.fda.gov/scripts/cder/ob";
  const resultsUrl = `${baseUrl}/results_product.cfm?Appl_Type=${appType}&Appl_No=${appNo}`;

  try {
    const res = await fetchWithTimeout(resultsUrl, 9000);
    if (!res.ok) return { dates: [], debug: `HTTP ${res.status} from Orange Book` };
    const html = await res.text();

    if (html.includes("No products found") || html.includes("no records")) {
      return { dates: [], debug: "No records found on Orange Book page" };
    }

    // Extract patent_info.cfm sub-page links
    const linkRegex = /patent_info\.cfm\?[^"']+/g;
    const links = [...new Set(html.match(linkRegex) || [])].slice(0, 5); // max 5 products

    if (links.length === 0) {
      return { dates: [], debug: "No patent info links found on results page" };
    }

    // Fetch each patent_info page and extract dates
    const now = new Date();
    const allDates: Date[] = [];

    for (const link of links) {
      try {
        const pageRes = await fetchWithTimeout(`${baseUrl}/${link}`, 6000);
        if (!pageRes.ok) continue;
        const pageHtml = await pageRes.text();

        // Extract MM/DD/YYYY dates
        const slashRegex = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g;
        let m;
        while ((m = slashRegex.exec(pageHtml)) !== null) {
          const d = parseSlashDate(m[1]);
          if (d && d > now && d.getFullYear() < 2060) allDates.push(d);
        }

        // Extract "Month DD, YYYY" dates
        const longRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/g;
        while ((m = longRegex.exec(pageHtml)) !== null) {
          const d = new Date(m[0]);
          if (!isNaN(d.getTime()) && d > now && d.getFullYear() < 2060) allDates.push(d);
        }
      } catch { continue; }
    }

    return { dates: allDates, debug: `Checked ${links.length} product page(s), found ${allDates.length} future date(s)` };
  } catch (e: any) {
    return { dates: [], debug: `Scrape error: ${e?.message || "unknown"}` };
  }
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

function parseSlashDate(raw: string): Date | null {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      accept: "text/html,*/*",
      "user-agent": "Mozilla/5.0 (compatible; DrugValue/1.0)",
    },
  }).finally(() => clearTimeout(timer));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function inferLOE(drugName: string): Promise<{
  loeDate: string | null;
  reasons: string[];
  sources: { label: string; url?: string }[];
}> {
  const fallbackYear = new Date().getFullYear() + 8;
  const fallbackDate = `${fallbackYear}-12-31`;

  const app = await fetchOpenFDAApp(drugName);

  if (!app) {
    return {
      loeDate: fallbackDate,
      reasons: [`"${drugName}" not found in FDA database. Using default estimate (+8 years).`],
      sources: [{ label: "Estimate — not found in FDA database" }],
    };
  }

  if (app.isBiologic) {
    return await inferBiologicLOE(app.appLabel, app.appNo);
  }

  const obUrl = `https://www.accessdata.fda.gov/scripts/cder/ob/results_product.cfm?Appl_Type=${app.appType}&Appl_No=${app.appNo}`;
  const { dates, debug } = await scrapeOrangeBookDates(app.appType, app.appNo);

  if (dates.length === 0) {
    return {
      loeDate: fallbackDate,
      reasons: [
        `Found ${app.appLabel} in FDA database but no expiry dates on Orange Book page.`,
        `Detail: ${debug}.`,
        `Using default estimate (+8 years).`,
      ],
      sources: [{ label: `FDA Orange Book — ${app.appLabel}`, url: obUrl }],
    };
  }

  const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
  const loeDate = latest.toISOString().slice(0, 10);

  return {
    loeDate,
    reasons: [
      `${app.appLabel}: ${debug}.`,
      `Latest expiry: ${latest.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`,
    ],
    sources: [{ label: `FDA Orange Book — ${app.appLabel}`, url: obUrl }],
  };
}
