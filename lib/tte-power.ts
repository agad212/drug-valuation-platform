// lib/tte-power.ts
//
// Native time-to-event (log-rank / Schoenfeld) power PRIMITIVES — Layer 1, Phase 1.
//
// Deterministic statistics only, no LLM. PURE + self-contained: this module depends on nothing
// else in the engine (it does NOT import normalCDF), so there is no import cycle with bayesian-rr —
// `schoenfeldZ` returns the argument to Φ(·) and the caller (rrTrialPower) applies the normal CDF.
//
// SINGLE-LOCUS: nothing here books an effect. `hr` is the hazard ratio the prior's θ-margin maps to
// (anchored in computeStageRR, 2a-style); events `d` is INFORMATION only (enters as √d). The effect
// lives in the prior over θ, integrated outside.

/**
 * Probability a subject has the EVENT during the study, under exponential survival (event hazard
 * `lambda` per month), uniform accrual over [0, accrualMonths], additional follow-up `followupMonths`,
 * and an optional independent competing dropout hazard `dropoutHazard`. Closed form — no simulation:
 *
 *   observation time for a subject entering at u~Uniform[0,A] is τ = A + f − u
 *   P(event) = (λ / μ) · ( 1 − E_u[e^{−μτ}] ),   μ = λ + λ_d
 *   E_u[e^{−μτ}] = (1/(μA))·(e^{−μf} − e^{−μ(A+f)})
 */
export function eventProbability(lambda: number, accrualMonths: number, followupMonths: number, dropoutHazard = 0): number {
  const mu = lambda + Math.max(0, dropoutHazard);
  if (mu <= 0 || accrualMonths <= 0) return 0;
  const f = Math.max(0, followupMonths);
  const avgSurvive = (1 / (mu * accrualMonths)) * (Math.exp(-mu * f) - Math.exp(-mu * (accrualMonths + f)));
  const pExit = 1 - Math.max(0, Math.min(1, avgSurvive));
  return (lambda / mu) * pExit; // fraction of exits that are EVENTS (not dropout)
}

export type TteAccrual = {
  controlMedianMonths: number; // control-arm median survival → λ_control = ln2 / median
  accrualMonths: number; // uniform accrual window
  followupMonths: number; // additional follow-up after accrual closes
  dropoutHazardPerMonth?: number; // optional competing dropout hazard
  nTotal: number; // total randomized
};

/**
 * Total expected events for the trial at a given hazard ratio, from the accrual/survival sub-model.
 * `allocationTreatFraction` = treatment-arm share (0.5 for a 1:1 RCT). λ_treat = HR · λ_control.
 * Events are INFORMATION (they set √d); they carry no effect.
 */
export function tteEventsFromAccrual(a: TteAccrual, hr: number, allocationTreatFraction = 0.5): number {
  const lambdaC = Math.log(2) / Math.max(1e-6, a.controlMedianMonths);
  const lambdaT = Math.max(1e-9, hr) * lambdaC;
  const nT = a.nTotal * allocationTreatFraction;
  const nC = a.nTotal * (1 - allocationTreatFraction);
  return (
    nT * eventProbability(lambdaT, a.accrualMonths, a.followupMonths, a.dropoutHazardPerMonth) +
    nC * eventProbability(lambdaC, a.accrualMonths, a.followupMonths, a.dropoutHazardPerMonth)
  );
}

/**
 * Schoenfeld z-statistic argument for a 1:1 log-rank test at hazard ratio `hr` with total events `d`:
 *
 *   Var(ln HR) ≈ 4 / d   →   Z = |ln HR|·√d / 2 − z_α
 *
 * Returns the argument to Φ(·); the caller applies the normal CDF (keeps this module CDF-free and
 * cycle-free). At HR = 1 (no effect) → −z_α → power collapses to the type-I rate, as it must.
 */
export function schoenfeldZ(hr: number, events: number, zAlpha: number): number {
  if (!(events > 0) || !(hr > 0)) return -Infinity;
  return (Math.abs(Math.log(hr)) * Math.sqrt(events)) / 2 - zAlpha;
}
