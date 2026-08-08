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

**1.1 FROZEN (regression tripwire).** Reference assets: **TTX-MC138 pApproval = 0.02844308071545876**
(`0.02844`), **tau / bms-986446 = 0.11418097492800683** (`0.11418`) — TTX pinned 2026-08-07 by the 2.2
anchored-scale fix; tau RE-PINNED #3 2026-08-07 night by the concurrent-control rule (benchmark
variance excluded from RCT power — the fixture carried designType rct + comparatorSigma2 0.01, a
documented-convention contradiction; new value inside the authored band [0.01, 0.15]; lineage in the
fixture `_repinNote` + the FROZEN_PAPPROVAL block of `tests/harness/valuation-harness.test.ts`). `tests/harness` must pass **29/29 byte-identical** on every
commit. FROZEN protects against *accidental* movement. A **deliberate re-pin**
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
`npx tsc --noEmit` = 0 · `npx vitest run` green (**currently 410**) · FROZEN harness byte-identical
(`tests/harness` — currently 54 across the golden harness + regression guards)
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

**Shipped since (2026-08-06/07):** LOE resolver thread (`lib/loe-resolver.ts` — statutory FDA terms +
PTE §156 computed deterministically, pProtective bands, weighted LOE cases, `E[revenuePV(LOE)]` over the
distribution: f062bbf / 71f6571 / e883add — replaces the old 4.2 `+8` fallback item); designation
propagation into the CPP band (f0afeb4); Option B critic COMPLETE — deterministic core (740ecee —
joint market intensity observables + flags) + LLM half (3545a1e — `/api/option-critic`, one batched
Sonnet call per valuation shape, gated by `lib/option-critic.ts` `validateCritiques` with a
structurally numeric-free advisory type; verdicts persist with a posture fingerprint so reloads never
re-pay for the call); 4.6 deprioritized-indication flag (59cdf55 — stalled/discontinued row named with
its % of headline, observe-and-flag, value not adjusted).

**Other open items:** `inferTherapeuticArea` has no respiratory/pulmonary-fibrosis TA so IPF falls
to `general` (an INPULSIS/ASCEND-scale Phase 3 costed as a cheap general trial — needs a literature CPP
band, calibration-blocked); 4.5 true per-indication dev plans (v1 IN PROGRESS — see below); Tier 3
(calibration, ChEMBL/Open Targets translational layer); Tier 5 exotics. **External blockers:**
calibration historical outcome/trial-cost data; Evaluate Omnium access.

**ROADMAP ORDER (agreed with the user 8/7 night): 4.5 first, THEN the AI-elicitation axis.**
- **4.5 v1 (now):** per-indication P derived from each indication's OWN remaining path — LOA from its
  current phase (BIO/Informa/QLS 2011–2020 transitions, `lib/indication-loa.ts`), non-lead rows only,
  explicit ptrs always wins, lead stays governed by the computed dev plan. Plus a launch-year floor
  (a row still needing Phase 3 cannot launch in 2 years). Zero API; capability-gated in effect (lead
  and single-indication paths byte-identical). Emissions stay interview-ready (structured fields +
  basis strings). v2 later: mechanism read-through, per-indication cost paths, class haircut.
- **AI-ELICITATION AXIS — MODULE 1 SHIPPED (6f522df + c4d8d9e): dev-plan interview + checker.**
  `lib/elicitation.ts` (sigma2FromBounds 15/85 convention, range coherence, N-of-10 cross-check,
  checker gate); prompt RULE 14; comparator σ² now DERIVES from an elicited range and supersedes raw
  emissions; checker = one batched Sonnet call auditing rationales (arithmetic/anchoring/base-rate
  neglect/availability/motivated optimism), findings ride the stage riskFlags rail, fail-open.
  **MODULE 3 SHIPPED (4440556 + ab428e7): revenue interview + checker.** Extremes-first p05/p95
  bear/bull (the old ±40-80% template deleted — it mandated the anchoring failure); structured
  `eligiblePatients` makes TAM arithmetic verifiable; deterministic `coherenceFlags` (TAM vs
  patients×price, peak vs TAM×pen, ordering, narrow-spread rail); batched checker call
  (anchoring/optimism/recency/base-rate-neglect/consistency) gated + fail-open with health marker;
  all rendered in the revenue panel; applying an estimate persists bearPeakM/bullPeakM and the
  scenario branches initialize from the TRUE elicited p05/p95 ratios. ALSO shipped same day
  (dcbb411 + cc0eb16): registry-n pin (CT.gov enrollment is a FACT), row-vs-deep-dive >2×
  divergence warning + TAM implied-patients line, IPF comparator pinned (event-free responder null
  0.68, ASCEND-cited — kills the 0.15→0.45→0.16 null swings; library pin beats elicited range).
  **MODULE 2 SHIPPED: LOE pProtective interview + checker.** loeFullPipeline prompt elicits
  pProtectiveLow/High (15/85, extremes first) + crossCheckOutOf10 ("of 10 comparable challenged
  patents of this type, how many hold?"); patentsFromKeyPatents validates the pass-through;
  loe-resolver flags range incoherence + framing disagreement (display-only — the band-clamped
  central still governs the case weights); checker via the SHARED lib/elicitation-checker.ts
  transport (built in the 8/8 self-review round: parseJsonLoose, 25s timeout, deadline skip,
  gate-failure honesty), findings rendered under Patent Analysis. SELF-REVIEW ROUND (cac9963):
  10-angle code review over dcbb411..eddecd3 found 15 real defects, all fixed — headline two:
  the dev-plan checker was ASSIGNING stage findings (destroying the registry-n pin disclosure —
  now append-only), and ScenarioPanel read elicited p05/p95 only at MOUNT (dead until reload —
  now derived per render via lib/scenario.elicitedPeakMultipliers with surfaced fallback reasons).
  Also: ESTIMATED-vs-ACTUAL registry wording, out-of-band n rejected WITH flag, comparator-pin
  supersession disclosed + digest-visible, IPF pin endpoint-family-gated (ipfEndpointFamilyMatch),
  bear=$0M honored end-to-end, NaN coercion, Apply-by-name, stale bear/bull cleared on re-run,
  eligiblePatients persisted + preferred over back-solve, IPF→rare_orphan CPP band.
  REMAINING MODULES: dependency statements (module 4);
  checker external-facts grounding (the "ZEPHYRUS-2 positive" gap). Original placement:
  (1) **Interview protocol** replaces one-shot emissions — extremes first, then bounds, then center,
  then a consistency cross-check via a second framing; ONE batched call per module (API frugality).
  Dev-plan module first (replicationRisk, expectedResponseRate, comparatorSigma2, nullRR), then LOE
  cases (pProtective), then revenue (WAC/share/count, bull/bear as p05/p95 or 15/85, never absolutes).
  (2) **Distributions, not points**: elicit fractiles; deterministic code fits (mirrors §1.4). Replace
  the hand-set 0.25/0.5/0.25 scenario weights with **Extended Pearson-Tukey 0.185/0.63/0.185 on
  p05/p50/p95 (Keefer & Bodily 1983)** — a derived, cited discretization.
  (3) **Checker pass** generalizes the Option B critic: one batched call auditing every elicited
  quantity's RATIONALE (not the number) for anchoring/availability/base-rate-neglect/motivated
  narrative + rationale↔number arithmetic (a tally of "2 of 6" must imply the stated pFail), on top of
  the existing deterministic coherence gates (sums-to-1, bands, unit gate).
  (4) Dependency statements: the AI must declare independence beliefs (same-mechanism indications are
  NOT defensibly independent — the existing correlation caveat becomes an elicited quantity).

**8/7 LIVE RUN (taladegib PDF) — verified & fixed same day.** Every shipped feature rendered correctly
(4.6 stalled flag with 27% share, critic verdicts, intensity flags 3.3×, containment clamp, designation
propagation). BUT headline P hit 61% vs the app's own 12–25% prior band (raw powers 91%/100%, ceilings
load-bearing): a sourced `expectedResponseRate` ≈0.5 had fired the Δ_stage path INVISIBLY — likely
"67% slowing of FVC decline" (a % improvement) wearing rate clothing. Fixed (f019eb9 + 7dd2f52 +
94f74e5): (1) margin scale ALWAYS rendered on the stage card (sourced rate + citation + unit caveat, or
labeled default) + riskFlags for FIRED/REJECTED/UNSOURCED; (2) deterministic UNIT GATE — the basis must
contain patient-proportion language or the rate is ignored + flagged (prompt 13b states the contract);
(3) **indication replication-risk component** (prompt 13c): LLM-cited NAMED Phase 2→confirmatory record
(IPF: nintedanib replicated; pamrevlumab/zinpentraxin/ziritaxestat/IFN-γ failed) → `replicationRisk
{pFail, basis}` → {w, μ=0} failure mass on the initial prior, citation-gated, band [0.05,0.80] (below
floor IGNORED never raised; above cap clamped DOWN shown), Bayes self-retiring, threaded through the
compute snapshot/restore (faithfulness) — the structural insight: σ²·Δ² keeps margin/sd = μ̄/σ regardless
of Δ, so a discrete non-replication hypothesis is representable ONLY as mixture mass (same move as the
surrogate→TTE component); (4) option-plan parity — per-option computeDevPlan now receives
therapeuticArea/orphanConfirmed/classGraveyardProb/replicationRisk (live gap: options priced the general
CPP band while the base priced rare_orphan) + regression pin; (5) display sweep — critic truncation caps
1600/600 with sentence-boundary cuts + max_tokens 3000, modality-matched LOE statute (no more BPCIA on a
small molecule), stale LOE snapshots labeled as pre-plan estimates, ghost devCostPV row shows
"superseded: dev plan governs". **VERIFIED LIVE 8/7 night (second refresh, after hard-reload):** replication flag fired (pFail 0.52,
named tally "~2 of 5-6 replicated"), margin-scale line renders on both stages (sourced Δ_stage 0.26 on
Ph2b with citation + unit caveat; labeled default on Ph3), failure mass visible in the bands (28% below
threshold → 0% by Ph3 = Bayes self-retirement working), Ph2b 43% raw (no ceiling), Ph3 raw 89% (was
100%), headline P 61% → **29%** — just above the strategic assessment's own 12–25% band, derived from
the named record. Comparator upgraded to an INPULSIS/ASCEND meta-analysis (σ²=0.009). Judgment items
surfaced by the flags, deliberately left to the human: the 45% rate is AI-INFERRED from continuous FVC
data (basis says so; VERIFY caveat displayed); the graveyard tally is slightly generous (pamrevlumab
double-listed, ziritaxestat/ISABELA omitted — the fuller record suggests pFail 0.6+, i.e. 29% errs
optimistic).
**Known open on this axis:** native continuous (dScale) routing for FVC-class endpoints instead of the
RR proxy; evidence-chain σ² calibration (the audit's own "may be too optimistic" pointer); stalled
oncology row still carries the IPF P + a 2028 launch (4.5 per-indication plans is the structural fix).
Gate counts: vitest 428, harness 54.

---

## 4. 2.2 — probability scale conflation: **FIXED AND MERGED (2026-08-07, merge 97deae5)**

> **STATUS: COMPLETE on main.** All four strata landed: the anchored map (`betaFromMeanVar` +
> `gaussianToBeta(μ,σ²,anchor)`, comparator built directly — no inverse), the cross-stage inverse
> (`gridToGaussianMixture`), anchor≠threshold (`anchorNullRR`, with the anchor sharing the threshold's
> ENDPOINT-FAMILY floor so the TTE-proxy floor relocates rather than taxes — the earlier "endpoint-
> agnostic anchor" was the TTX-collapse bug), and the surrogate→TTE translation-failure component.
> Tripwires re-pinned with literature validation: TTX 0.08986→**0.02844** (≈ the 3.4% oncology
> early-phase base, Wong/Siah/Lo 2019), tau 0.26751→**0.02519** (anti-tau class: zero approvals,
> p_graveyard 0.872; band re-authored [0.01,0.15]). G2-2a proxy-vs-native divergence: 3.52× → 1.43×.
> **DEFERRED refinement (the next item on this axis): sourced-margin unification for the proportion
> family** — Δ_stage from a sourced expectedResponseRate (the dScale/hrScale pattern that made the
> continuous/TTE families immune), Δ=0.10 as labeled fallback; needs an emission field + a
> no-double-count design vs the evidence chain. Rate-evidenced assets (TTX's 64% observed clearance)
> currently ride the 0.10 default — conservative, flagged, not silent.
> The history below is retained for context; the "parked" status it describes is superseded.

> **(superseded) STATUS 2026-08-07 earlier: attempted at full session scale; parked on branch
> `feat/2.2-anchored-scale` (commit 0680dcd) — main remained on the old scale at that point.**
> Three of the four architectural strata are SOLVED in working code on that branch (393/399 green):
> the anchored map + `betaFromMeanVar` (comparator built directly — the bidirectional inverse is
> *eliminated*, not changed); the cross-stage inverse in `gridToGaussianMixture` (without it every
> posterior hand-off halves the margin — tau collapsed to 0.0099 until fixed); and **anchor ≠
> threshold** in `computeStageRR` + `DevStageInput.anchorNullResponseRate` (without the separation,
> every harder-bar mechanism — active comparator, TTE floor — is neutralized because the prior
> re-anchors on the raised bar). Plus: the surrogate→TTE penalty re-expressed as a translation-failure
> mixture component (variance widening can INVERT under Jensen on the anchored scale), and three
> saturation-artifact test discoveries (ceiling-guard fixtures, the NO-DOUBLE-COUNT equality, the
> sequential single-locus helpers only "worked" because the old scale saturated stage powers to ~1).
>
> **THE BLOCKER (the fourth stratum, why it is parked): the μ emissions themselves are calibrated to
> the old absolute reading.** TTX: the chain saw 64% observed ctDNA clearance and emitted finalMss
> 0.313 — sensible as "plausible true absolute RR ≈ 0.31 after shrinkage", but as a margin multiplier
> μ = 0.63 means "clears the null by 6.3 points": an ~8× weaker claim. On the branch TTX lands at
> pApproval 0.0004 / eNPV −$12M — confidently wrong in the OPPOSITE direction, so the validation step
> (correctly) refused the re-pin. Completing 2.2 = re-pinning the effect-prior CHAIN's μ semantics to
> the margin reading: prompts, the mss×2 legacy mapping, and the evidence-step anchors ("mu ≈ 1.30")
> re-derived against margins — noting a 64%-vs-15%-null observation is a +50pt margin ≈ μ 5 on the
> Δ=0.10 scale, so either μ ranges beyond [0,2] for rate-evidenced assets or Δ becomes
> endpoint-derived. That is a domain-calibration decision (what "average evidence" means against WHICH
> baseline, per endpoint family) — needs the human + a literature pass, THEN the branch's validation
> re-run and the deliberate golden re-pin. Also on the branch: fixture (i-c) needs comparatorSigma2
> 0.004 (0.0005 saturates even μ=1.5).

### Original diagnosis (still accurate)

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
