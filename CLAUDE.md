# DrugValue — AI-Powered Pharma Asset Valuation Platform
## CLAUDE.md — Session Continuity Document

This file gives Claude Code full context to resume work immediately without re-exploration.

---

## Project Vision

DrugValue is a SaaS platform for pharmaceutical professionals to value drug pipeline assets using risk-adjusted NPV (rNPV) and probability of technical success (PTRS). It combines:
- Rigorous financial modeling (DCF, scenario analysis, sensitivity)
- Regulatory intelligence (FDA Orange Book, ClinicalTrials.gov, patent databases)
- AI-driven insights (Claude-powered assistant + patent analysis)
- Clean, shareable output for deal memos and BD presentations

Target users: biotech/pharma business development teams, licensing professionals, investors doing pipeline due diligence.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14.2.5 (Pages Router) + TypeScript 5.5 |
| UI | React 18, Tailwind CSS 3.4, Recharts 2.12 |
| Theming | next-themes (dark/light mode), CSS custom properties |
| AI | Anthropic Claude (via `ANTHROPIC_API_KEY`) — Haiku for chat, Sonnet for patents |
| Search | Tavily API (`TAVILY_API_KEY`) — web + patent database access |
| Database | Neon Postgres (`@neondatabase/serverless`) — optional, in-memory fallback |
| Auth | NextAuth 4.24 (GitHub + Google OAuth) — optional |
| Deployment | Vercel (`.vercel/project.json` present) |

**Important:** The README still says OpenAI — that's outdated. The app was migrated to **Anthropic Claude**. The active AI key is `ANTHROPIC_API_KEY` in `.env.local`.

---

## Directory Structure

```
drugvalue_build/
├── pages/
│   ├── index.tsx                  # Main valuation builder UI (596 lines)
│   ├── share/[slug].tsx           # Read-only shareable valuation page
│   └── api/
│       ├── auth/[...nextauth].ts  # NextAuth (GitHub/Google)
│       ├── chat.ts                # AI assistant (Claude)
│       ├── trial/[nctId].ts       # ClinicalTrials.gov lookup
│       ├── loe/[drugName].ts      # Quick LOE (FDA Orange Book only)
│       ├── loe-full/[drugName].ts # Full LOE (Orange Book + patents + web)
│       ├── patents/[drugName].ts  # Patent analysis (Tavily + Claude)
│       ├── valuations.ts          # Save/list valuations
│       └── valuation/[id].ts      # Retrieve specific valuation
├── components/
│   ├── AssistantPanel.tsx         # AI chat sidebar (217 lines)
│   ├── ValuationCharts.tsx        # Tornado, waterfall, timeline (220 lines)
│   ├── ThemeProvider.tsx          # next-themes wrapper
│   ├── ThemeToggle.tsx            # Header theme toggle button
│   ├── Toast.tsx                  # Toast notification system
│   └── ui/card.tsx                # Basic card component
├── lib/
│   ├── types.ts                   # All TypeScript types
│   ├── cashflow.ts                # Core rNPV/PTRS/RevenuePV engine
│   ├── store.ts                   # Valuation persistence (in-memory or Neon)
│   ├── ctgov.ts                   # ClinicalTrials.gov API v2 connector
│   ├── db.ts                      # Neon Postgres setup
│   └── loeAdapter.ts              # FDA Orange Book + BPCIA LOE inference
├── styles/globals.css             # Design system: fonts, colors, gradients
├── .env.example                   # Template (shows OPENAI key — outdated)
├── .env.local                     # Active config (ANTHROPIC + TAVILY keys present)
├── next.config.js
├── tailwind.config.ts
└── package.json
```

---

## Core Financial Model (`lib/cashflow.ts`)

### PTRS Calculation
- **Base probabilities by phase**: Preclinical 7%, Phase 1 14%, Phase 2 25%, Phase 2b 33%, Phase 3 60%, NDA/BLA 85%, Approved 100%
- **Mechanism adjustments**: 40+ targets scored. Examples:
  - PD-1/PD-L1: +8% (well-validated)
  - BCR-ABL, HER2, CDK4/6: +8%
  - KRAS G12C: +3% (recently validated)
  - PCSK9: +5% (validated, competitive)
  - MYC: -6% (historically intractable)
  - Novel/uncharacterized: -3% to -4%
- Final PTRS is clamped between 1% and 99%

### Revenue PV Calculation
- Ramp profile: Launch year 20%, Y+1 50%, Y+2 80%, Y+3+ 100% of peak sales
- Post-LOE revenue: 50% of peak (generic/biosimilar erosion)
- Deductions: COGS%, working capital%, tax rate%
- If Licensor mode: applies royalty% instead of full revenue
- Discounts all cash flows at `discountRate` (default 12%) from current year

### rNPV Formula
```
rNPV = (RevenuePV × PTRS) - DevCostPV
```

### Tornado Chart (Sensitivity Analysis)
Varies 6 drivers by ±25% (peak sales), ±10% (PTRS), ±3% (discount rate), ±25% (dev cost), ±3 years (launch/LOE) and shows rNPV impact.

---

## LOE Inference Strategy (`lib/loeAdapter.ts`, `pages/api/loe-full/`)

1. **FDA Orange Book** (most authoritative for small molecules) — scrapes patent expiry dates
2. **BPCIA 12-year rule** (biologics) — 12 years from FDA approval date via openFDA
3. **Patent analysis** (`/api/patents/[drugName]`) — Tavily searches Google Patents/LENS/Espacenet, Claude extracts filing years, types (compound/formulation/method-of-use), estimated expiries with/without PTE
4. **Web search** — Tavily searches for analyst LOE estimates, earnings calls, press releases
5. **Default fallback** — launchYear + 8 years if nothing found

The `/api/loe-full/` endpoint returns `{ loeYear, loeMin, loeMax, isDefinitive, confidence, orangeBook, patents }`.

---

## AI Assistant (`pages/api/chat.ts`, `components/AssistantPanel.tsx`)

- Uses Claude (Haiku model) with valuation context in system prompt
- Explains rNPV drivers, PTRS methodology, LOE assumptions
- Can suggest field updates via `<field-update field="peakSales" value="2000000000"/>` XML tags
- User reviews/accepts before fields update in the form
- Optional Tavily web search for recent news (pipeline updates, approvals, market data)
- AssistantPanel has quick-prompt buttons for common questions

---

## Data Schema

### Valuation Type (`lib/types.ts`)
```typescript
{
  id?: string;
  slug?: string;                    // For shareable URLs
  name?: string;                    // Valuation name
  asset?: string;                   // Drug/compound name
  indication?: string;
  mechanism?: string;               // Target mechanism (used for PTRS adjustment)
  sponsor?: string;                 // Company (used for patent/LOE lookup)
  ownerType?: "Owner" | "Licensor";
  peakSales?: number;               // Annual peak sales ($)
  discountRate?: number;            // Default 0.12
  cogsPct?: number;                 // Cost of goods sold fraction
  taxRate?: number;
  workingCapitalPct?: number;
  avgRoyalty?: number;              // Only for Licensor mode
  launchYear?: number;
  loeYear?: number;
  phase?: string;
  ptrs?: number;                    // 0–1
  devCostPV?: number;               // R&D cost PV ($)
  revenuePV?: number;               // Calculated output ($)
  rnpv?: number;                    // Calculated output ($)
  roi?: number;                     // Calculated output
  sources?: Source[];               // Citations from API lookups
  createdAt?: string;
  updatedAt?: string;
}
```

### Database (Neon Postgres, if `DATABASE_URL` is set)
```sql
CREATE TABLE valuations (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Currently running **in-memory** (no `DATABASE_URL` in `.env.local`). `lib/store.ts` auto-detects and falls back gracefully.

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/valuations` | List all saved valuations |
| POST | `/api/valuations` | Save/upsert valuation |
| GET | `/api/valuation/[id]` | Retrieve valuation by ID |
| POST | `/api/chat` | Claude AI assistant message |
| GET | `/api/trial/[nctId]` | ClinicalTrials.gov data |
| GET | `/api/loe/[drugName]` | Quick LOE (FDA only) |
| GET | `/api/loe-full/[drugName]?sponsor=X` | Full LOE pipeline |
| GET | `/api/patents/[drugName]?sponsor=X` | Patent analysis |

---

## Environment Variables

```bash
# Required for AI features
ANTHROPIC_API_KEY=sk-ant-api03-...   # Claude API — ACTIVE in .env.local
TAVILY_API_KEY=tvly-dev-...          # Web/patent search — ACTIVE in .env.local

# Optional — enables persistent storage
DATABASE_URL=postgresql://...        # Neon Postgres (not set → in-memory mode)

# Optional — enables user login
NEXTAUTH_SECRET=...                  # Auto-generated, present in .env.local
GITHUB_CLIENT_ID/SECRET=...
GOOGLE_CLIENT_ID/SECRET=...
```

---

## Design System

- **Fonts**: Syne (display/headings), DM Mono (monospace/numbers)
- **Accent**: `#10b981` (emerald green)
- **Danger**: `#f87171` (red), **Warning**: `#fbbf24` (amber)
- **Background**: Animated ocean-gradient (Virgin Islands blue tones)
- **Cards**: Semi-transparent glass effect with backdrop blur
- **Dark mode**: Automatic via next-themes; all colors use CSS custom properties
- No CSS modules — styles are inline or in `globals.css`

---

## Build & Run

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # Production build
npm run start        # Serve production build
npm run lint         # ESLint
```

Deployed on **Vercel** — push to GitHub and Vercel auto-deploys. `.vercel/project.json` is already configured.

---

## Roadmap & Current Status

### Phase 1 — DONE
- [x] rNPV/PTRS financial engine
- [x] In-memory valuation store
- [x] AI assistant (Claude)
- [x] ClinicalTrials.gov lookup
- [x] Dark/light theme, shareable links

### Phase 2 — DONE
- [x] Real FDA Orange Book LOE parsing
- [x] Mechanism-based PTRS scoring (40+ targets)
- [x] Phase-based PTRS priors
- [x] Patent analysis via Tavily + Claude
- [x] Web-based LOE estimates via Tavily
- [x] Full LOE pipeline endpoint (`loe-full`)

### Phase 3 — NEXT
- [ ] Neon Postgres persistence (code exists in `lib/store.ts`, needs `DATABASE_URL`)
- [ ] User authentication (NextAuth configured, just needs OAuth app creds)
- [ ] User-specific valuation history (currently all valuations are shared in-memory)
- [ ] Consensus/community valuations (multi-user aggregation)

### Phase 4 — FUTURE
- [ ] Embeddable widgets for BD presentations
- [ ] Pro tier with subscription gating
- [ ] API access for partners/integrations
- [ ] Comparable transaction database

---

## Key Decisions Made

1. **Migrated from OpenAI → Anthropic Claude** — README is stale, actual code uses `ANTHROPIC_API_KEY`. The `chat.ts` and `patents.ts` endpoints both call Claude.

2. **Pages Router, not App Router** — Chosen for stability with Next.js 14. Don't migrate to App Router without good reason.

3. **In-memory store as default** — Zero-config for local dev. `lib/store.ts` switches to Neon automatically when `DATABASE_URL` is present.

4. **No CSS modules** — All styling via Tailwind + inline styles with CSS custom properties. Keep this pattern.

5. **Tavily for patent search** — Chosen over direct patent API integrations because it aggregates Google Patents, LENS, and Espacenet in one call.

6. **Field-update XML pattern for AI** — The assistant uses `<field-update>` tags so users can review AI suggestions before applying them. Don't change this to auto-apply.

7. **Owner vs Licensor modes** — Two revenue models: Owner (full revenue minus COGS/taxes) and Licensor (royalty% of peak sales only). The `avgRoyalty` field only applies in Licensor mode.

---

## Watch Out For

- **README is outdated** — says OpenAI, references Phase 2 as future. The README was never updated after Claude migration.
- **`.env.example` is outdated** — shows `OPENAI_API_KEY`, should be `ANTHROPIC_API_KEY`.
- **No git history** — the working directory is not a git repo (`Is a git repository: false`). Changes aren't tracked.
- **API keys in `.env.local`** — present and active. Never commit `.env.local`.
- **In-memory store resets on server restart** — expected behavior in dev. For persistence, set `DATABASE_URL`.

---

## Running the App

```bash
cd "C:\Users\gada\OneDrive - Bristol Myers Squibb\Documents\personal\drugvalue\drugvalue_v2\drugvalue_build"
npm run dev
# Opens at http://localhost:3000
```
