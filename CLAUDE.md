# DrugValue — AI-Powered Pharma Asset Valuation Platform
## CLAUDE.md — session continuity (rev 2026-08-06)

Resume work immediately from this file. It replaces an earlier revision that was badly stale (it claimed
an in-memory store, "Neon is next", a 596-line index, and no test harness — all wrong).

**Live:** https://drugvalue.vercel.app · **Repo:** github.com/agad212/drug-valuation-platform (Vercel
auto-deploys on push to `main`) · **Path:** `C:\Users\gada\OneDrive - Bristol Myers Squibb\Documents\personal\drugvalue\drugvalue_v2\drugvalue_build`

The whole proposition is that **a number is DERIVED, not TARGETED**. §1 below is not process; it is what
makes the product trustworthy. A finished-looking product full of output caps and tuned inputs is worse
than an unfinished honest one.

---

## 1. Governing invariants — non-negotiable

**1.1 FROZEN (regression tripwire).** Reference assets: **TTX-MC138 pApproval = 0.08985679656422688**
(`0.08986`), **tau / bms-986446 = 0.2675078005848638** (`0.26751`). `tests/harness` must pass **29/29
byte-identical** on every commit. FROZEN protects against *accidental* movement. A **deliberate re-pin**
is allowed when a change legitimately touches the reference path: recompute, confirm the movement is
intended and correct, update the fixture `expected` block, and document why in the commit. **Forbidden:**
silent drift. An unexplained change is an accidental regression — find it, don't re-pin around it.
Both fixtures are **single-indication** and ride the **proportion (RR-proxy)** path; they do **not**
traverse the niche/enriched or multi-indication branches. Changes confined to those branches leave the
harness byte-identical — confirm it rather than assume.

**1.2 Adjust INPUTS, never cap OUTPUTS. Never tune to target.**
- *Allowed:* fix an input that is **provably wrong by an independent check** — an internal contradiction
  (subset > superset), a band/precedent violation, a fabricated default, a citation-less claim, a sourced
  value being silently replaced by a derived one.
- *Forbidden:* adjusting an input because the output "looks too high". That is reverse-engineering.
- **The test:** *"Would this input still be wrong if I couldn't see the output?"* If yes → fix. If no → don't.

**1.3 Pin to literature/precedent, not to the answer.** Bands, priors and defaults are grounded in cited
sources, never chosen to produce a number. Divergence between result and expectation triggers **input
scrutiny**, never an output adjustment.

**1.4 The LLM specifies; deterministic code computes; no-leak.** LLMs emit structure, inputs and
reasoning — never numbers that reach the headline. Import-graph-provable: interpreter/generator modules
import no compute math and carry no numeric-result field.

**1.5 Resolve-or-flag — never a silent default.** Every clamp/fallback/substitution is surfaced with both
sides shown ("requested X; used Y because Z"). `resolveNicheParam` / `resolveNicheEligible` /
`pinCostPerPatient` are the pattern: band + citation-required + clamp-to-edge + flag.

**1.6 Never silently weaken a test or invariant.** If a fix conflicts with an assertion, decide whether
the assertion was asserting the right thing, change it **with a stated reason in the commit**, and keep
the intent. (Done twice: the market-model *decoupling* test was re-axed to separate peak-decoupling from
population containment; regression-guard *Guard 7* was re-pointed from central-replacement to
clamp-to-edge and came out stronger — 5 resolutions pinned instead of 1.)

**1.7 Self-verification gates, per coherent unit of work.**
`npx tsc --noEmit` = 0 · `npx vitest run` green (**currently 361**) · FROZEN harness 29/29 byte-identical
(or a documented re-pin) · `npm run build` = 0 · the relevant import-graph greps. A red gate = fix that
item before proceeding.

---

## 2. Architecture

**Stack:** Next.js 14.2.5 **Pages Router** + TS 5.5 · React 18 · Recharts · Tailwind + inline styles with
CSS custom properties (no CSS modules) · Anthropic Claude (`ANTHROPIC_API_KEY`) · Tavily
(`TAVILY_API_KEY`) · **Neon Postgres — LIVE** (`DATABASE_URL` set; verified `path:"neon"` in production
logs) with in-memory fallback · Vercel. Site is behind a gate cookie (`middleware.ts`) — everything is
locked except `/survey`, `/gate`, `/api/{survey,auth,gate}` and static assets.

**Deterministic engine (pure, no I/O — this is the protected core):**
- `lib/cashflow.ts` — `computeOutputs`; multi-indication aggregation (headline eNPV = Σ per-indication
  rNPV under the resolved structure, never pooled-revenue × one P). Line ~143 `ind.devCostPV ??
  globalDevCostShare` was the $3M-IPF cost-basis bug (fixed 84d8b5c by display-routing to the
  risk-adjusted share).
- `lib/dev-plan.ts` — `computeDevPlan`: per-stage probability, base-rate ceilings
  (`STAGE_SUCCESS_CEILING` / `LATE_PHASE_SUCCESS_CEILING`), modality-class haircut, cost accounting via
  `pinCostPerPatient`, timeline normalization.
- `lib/bayesian-rr.ts` — `computeStageRR`: the Bayesian integral `P = ∫ P(success|θ)·prior(θ)dθ`,
  design-aware power (free alpha, native TTE Schoenfeld, group-sequential + β-spending futility,
  single-look Bayesian), `gaussianToBeta` / `mixtureToBeta` coordinate transform. **See §4 — this module
  holds the biggest known open defect.**
- `lib/effect-prior.ts` — the 4-step chain (mechanism → animal → analog → own-clinical), `enrichEffectPrior`.
- `lib/decision-analysis.ts` — `computeOption` / `computeAllOptions` / `buildBaseContext`; each option's
  `deltaENPVM` / `marginalEROI` anchors to the **baseline option** (not the program).
- `lib/market-model.ts` — `calibrateBaseMarket` (back-solves tamM = peak/penetration so
  `deriveMarket(base) === basePeak` — the *decoupling identity*), `deriveEnrichedNiche`,
  `resolveNicheParam` (WAC band `$150k–$300k`, share band `20–50%`), `resolveNicheEligible`
  (**containment: niche count ≤ superset × prevalence**).
- `lib/financial-pins.ts` — `pinCostPerPatient` (phase × therapeutic-area CPP bands, clamp-to-edge),
  `anchorPeakSales`, `computeLoeYear`.
- `lib/self-check.ts` — A1–A7 structural blockers, **A8** (headline == structural Σ), **B1** eROI-ceiling
  WARN (~50×, hand-set, *provisional pending calibration*), **B2** cost-basis divergence, **B3**
  per-indication rNPV sanity. Flags, never adjusts; imports no compute.

**Reasoning layer (LLM → validated structure → engine):** `/api/dev-plan`, `/api/lead-reasoner`,
`/api/auto-value`, `/api/effect-prior`, `/api/ptrs-score`, `/api/ptrs-layer2`, `/api/revenue-assumptions`,
`/api/indication-structure` (+ `lib/indication-structure-interpreter.ts`, deterministic validator:
malformed/dangling/self-ref/cycle → demote-to-independent + flag), `/api/design-interpreter` →
`TrialDesignSpec`, `/api/decision-options`, `/api/loe-full`, `/api/patents`.
`vercel.json` holds per-endpoint `maxDuration` (dev-plan 240; indication-structure / decision-options /
design-interpreter 120; the 300s ones unchanged) — raised in b142b38 to fix systematic 504s.
`lib/endpoint-timing.ts` emits `endpoint-timing` logs; `lib/store.ts` emits `store-diagnostic`
(`databaseUrlLive`, `path:"neon"|"memory"`).

**UI:** `pages/index.tsx` (large — chat is the primary command surface, driving the same setters through
`lib/valuation-input-validator.ts` as the choke point). Persistence: auto-restore on reload from
localStorage + a **faithfulness assert** (recompute-from-restored-state must equal the stored governed
headline, else fall back to inputs-only + banner). `pages/share/[slug].tsx` reads the store **in-process**
in `getServerSideProps` (a self-fetch gets 401'd by the gate — that was the share-404 bug);
`components/SharedValuationView.tsx` renders a faithful read-only mirror reusing the app's own section
components, with a `readOnly` mode on `DecisionAnalysis` that **suppresses the LLM auto-insight fetch** so
a share view never burns credits or mutates the snapshot. Unified **Option 1…N** model: Option 1 = the
full-program valuation (== headline); a labeled lead-baseline **reference**; Options 2…N = lead-indication
reshapes with Δ anchored to the computeOption lead baseline. Labels are `1 / Base / 2 / 3` everywhere.

---

## 3. Roadmap position (Tier 2 status)

| Item | Status |
|---|---|
| 2.1 niche eligible-count containment bound | **SHIPPED** `4f2babd` — verified firing live |
| 2.3 CPP clamp-to-edge + in-band citations honored | **SHIPPED** `7a9ca4e` (Guard 7 reconciled; cost goldens re-pinned) |
| 2.4 niche WAC floor = broad WAC | **SHIPPED** `83010ba` (latent guard; didn't bite the last run) |
| eligible count from **sourced** TAM, not back-solved | **SHIPPED** `c0f9f6c` — found by live verification |
| **2.2 P(approval) over-optimism** | **DIAGNOSED, NOT FIXED — see §4. Top priority.** |

**Verified on the 2026-08-06 live run:** the containment flag renders (`count CLAMPED to 35,648 [cited
45,500 EXCEEDS the base-population bound …]`); CPP shows `sourced, within band`; **all B1 eROI flags
cleared** (two fired pre-fix at 53× and 60×).

**Still open (not provably-wrong inputs — these need the Option B critic, §3.1, not a clamp):** the
biomarker options' remaining elevation is WAC ~2–2.3× broad × share ~3.3–3.75× broad on ~35% of patients.
Each input is individually cited and in-band, and a precision label genuinely *can* price and penetrate
above a broad one, so containment does not falsify them.

**Other open items:** designation propagation (a confirmed FDA/EC orphan designation does **not** reach
`stage.trialDesign.regulatoryContext`, so designated assets never reach the `rare_orphan` CPP band and are
systematically under-costed); `inferTherapeuticArea` has no respiratory/pulmonary-fibrosis TA so IPF falls
to `general` (an INPULSIS/ASCEND-scale Phase 3 costed as a cheap general trial); 4.2 LOE `+8` fallback
(live: LOE 2031 while the same patent analysis cites method-of-use/formulation cover to ~2041–2045 —
materially understates the window; **the selection rule is a domain judgment, ask the human**); 4.5 true
per-indication dev plans; 4.6 deprioritized-indication flag (live: the stalled solid-tumours leg
contributes ~27% of headline as if active); Tier 3 (Option B critic, calibration, ChEMBL/Open Targets
translational layer); Tier 5 exotics. **External blockers:** calibration historical outcome/trial-cost
data; Evaluate Omnium access.

---

## 4. The open defect: 2.2 — probability scale conflation

**Symptom.** Stage success saturates: raw Phase 3 hit **100%** (8/5 run) and **93%** (8/6 run); the
base-rate ceilings (80/90%) are capping an already-broken raw number. Worse, P(approval) is **unstable**:
**61% on 8/5 vs 26% on 8/6 for the same asset**, driven only by LLM-emitted design descriptors (n=80 +
placebo "Low" vs n=41 + "Moderate").

**Root cause.** `lib/bayesian-rr.ts` `gaussianToBeta` maps `mean_rr = mu / 2`. But the effect-prior **μ is
a relative effect-strength multiplier** (1.0 = "average confirming evidence"; the chain emits 1.13–1.50).
Reading it as an **absolute response rate** asserts *an average drug has a 50% response rate*, which
against a `nullRR` of 0.10–0.20 builds in a ~30-point effect before any evidence.
Corroborated by the suite's own log: `[G2-2a] proportion proxy P=0.6537 | continuous native P=0.1859` —
the proxy yields **3.5×** the native continuous power for the same stage.

**Why it is NOT a one-line fix.** `μ/2` is the module's **coordinate system, used bidirectionally** —
`bayesian-rr.ts:~770` builds the *comparator* Beta by inverting it
(`gaussianToBeta(nullRR * 2, comparatorSigma2 * 4)`). Changing one side alone puts the drug prior and the
comparator prior on different scales: a confidently-wrong probability core, the worst possible failure
mode here.

**Execution plan (do all of it in ONE commit):**
1. Anchor the map on the **comparator**, affine: `mean_rr = flooredNull + μ · AVERAGE_EVIDENCE_DELTA_RR`
   with `AVERAGE_EVIDENCE_DELTA_RR ≈ 0.10` (μ=1.0 clears the comparator by the minimum clinically
   meaningful margin; `MEANINGFUL_RR_FLOOR = 0.10` already encodes that concept). Variance transforms as
   `var_rr = σ² · Δ²` (affine `y = a + bx` ⇒ `b²`).
2. **Use `flooredNull`, not `effectiveNull`** — `effectiveNull` depends on `priorMoments`, which depends on
   the Beta grid: circular. `flooredNull = max(nullRR, floor)` is input-only. Bonus: the affine map puts
   the prior mean above `flooredNull` by construction, making the `comparatorUnreliable` band-aid
   (~line 1096) unreachable — remove it visibly per §1.6, don't leave it dead.
3. Change the **comparator inverse at ~770 in the same commit**, consistently.
4. Update the ~20 assertions in `lib/__tests__/bayesian-rr.test.ts` that pin the old semantics (comments
   `mean_rr ≈ 0.40 / 0.25 / 0.10 / 0.70`), plus the `priorMean` helpers at `design-power.test.ts:14` and
   `sequential-power.test.ts:172`. Reconcile visibly (§1.6) — these assert the mapping *itself*.
5. **Deliberate tripwire re-pin** (§1.1): both fixtures ride this path, so TTX/tau **will** move. Confirm
   the new values are *more* defensible, update the fixtures, document.

**Validation that makes this §1.3-legal rather than target-tuned** (worked out, not fitted): at typical
trial sizes the mapping reproduces documented phase base rates on its own — Phase 3 (null .20, n=280):
Δ .113, z 2.16 ⇒ **power ≈ 58%** vs BIO/Informa Phase 3 ~58–60%; Phase 2b (null .15, n=80): z 1.25 ⇒
**≈ 35%** vs Phase 2 ~30–35%. Check the corrected **raw** probabilities are defensible on a spread of
assets — *not* that the headline matches any prior band.

---

## 5. Working notes

- **Gates:** `npx tsc --noEmit` · `npx vitest run` · `npx vitest run tests/harness` · `npm run build`.
- **PowerShell:** `git push`/`git status` piped output often returns **exit 255 / NativeCommandError** as
  a stderr artifact even on success — verify with `git log -1 --oneline` and `git status -sb` rather than
  trusting the exit code. Commit long messages via a file: `git commit -F <path>` (a here-string gets
  parsed as pathspecs, and `Out-File utf8` adds a BOM to the subject).
- `tsconfig.tsbuildinfo` is tracked; it shows up modified after any typecheck.
- Don't migrate to App Router. Keep the `<field-update>` review pattern (never auto-apply). Owner vs
  Licensor revenue modes both exist (`avgRoyalty` applies only to Licensor).
- Memory lives at `C:\Users\gada\.claude\projects\C--WINDOWS-system32\memory\project_drugvalue.md` and is
  updated incrementally — read the tail for the latest session's findings.
