# DrugValue — Pharma Asset Valuation Platform

AI-powered rNPV / PTRS valuation platform for drug pipeline assets.

## Stack
- Next.js 14 + TypeScript
- Tailwind CSS (custom design system)
- Recharts (tornado, waterfall, revenue timeline)
- OpenAI GPT-4o mini (assistant)
- ClinicalTrials.gov API v2 (trial data)
- In-memory store (swap for Neon/Prisma for persistence)

## Quick Start

```bash
npm install
cp .env.example .env.local
# Add your OPENAI_API_KEY to .env.local
npm run dev
```

Open http://localhost:3000

## Deploy to Vercel

```bash
# 1. Push to GitHub
git init && git add . && git commit -m "initial"
git remote add origin https://github.com/YOURUSERNAME/drugvalue.git
git push -u origin main

# 2. Import on Vercel
# vercel.com → New Project → Import from GitHub

# 3. Add environment variable in Vercel dashboard:
# OPENAI_API_KEY = sk-...
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes (for AI assistant) | OpenAI API key |
| `DATABASE_URL` | No (Phase 3) | Neon Postgres connection string |

## Project Structure

```
lib/
  cashflow.ts     — rNPV / PTRS / Revenue PV engine
  loeAdapter.ts   — LOE inference (stub; replace with Orange Book)
  ctgov.ts        — ClinicalTrials.gov API v2 connector
  store.ts        — In-memory valuation store
  types.ts        — TypeScript types

pages/
  index.tsx       — Main valuation builder
  share/[slug]    — Shareable read-only valuation page
  api/
    chat.ts       — AI assistant (OpenAI)
    trial/[id]    — CT.gov trial lookup
    loe/[drug]    — LOE inference
    valuations.ts — Save valuation
    valuation/    — Get / share valuation

components/
  ValuationCharts.tsx  — Tornado / Waterfall / Timeline charts
  AssistantPanel.tsx   — AI chat sidebar
  ThemeToggle.tsx      — Dark/light toggle
```

## Roadmap

- **Phase 2**: Real Orange Book LOE parsing, mechanism scorer, PTRS priors
- **Phase 3**: Neon/Prisma persistence, user auth, consensus valuations
- **Phase 4**: Embeddable widgets, Pro tier, API access
