// lib/persistence.ts
//
// PURE persistence-decision helpers (NO React, NO localStorage, NO compute). This module holds ONLY the
// two decisions that make "restore the COMPUTED valuation without re-running the pipeline" safe, so they
// can be unit-tested without a DOM:
//
//   1. classifyRestore()  — version-guard: given a stored record, decide whether to do a FULL restore
//      (rehydrate the LLM-produced pipeline state so the pure engine recomputes the headline), an
//      INPUTS-ONLY restore (rehydrate the inputs only), or treat it as a VERSION-MISMATCH (a record from
//      a different schema → ignore its compute state, never render stale numbers as current).
//
//   2. assertFaithful()   — the restore-faithfulness invariant: after the pure memos recompute from the
//      restored state, the recomputed headline MUST equal the headline that was stored at save time
//      (within display rounding). If it doesn't, the persisted state is corrupt/stale for this build and
//      the caller falls back to inputs-only + surfaces a flag — so "restore is byte-identical" is a
//      CHECKED invariant, not a hope.
//
// This file touches NO engine (computeOutputs / computeDevPlan / buildBaseContext), effect-prior math,
// reg scale, aggregation, A8, interpreters, or the memo graph — it is storage/restore plumbing only.

// Bump when the shape of the persisted `_compute` snapshot changes in a way that would make an old
// snapshot recompute to a different (or broken) headline. A mismatch → the stored compute state is
// ignored (inputs-only restore), never rendered as if current.
export const PERSIST_SCHEMA_VERSION = 1;

// The headline the valuation displays, stored at save time and re-asserted on restore.
//   headlineRnpvM — the GOVERNED eNPV in $M (multi-indication: the structural Σ; single: devPlan.eNPVM;
//                   pre-dev-plan: out.rnpv/1e6). NOT out.* for a governed asset (that was the pre-84d8b5c
//                   cost-basis number — see the share-payload fix).
//   pApproval     — devPlan.pApproval, or null when no dev plan governs.
export type GovernedTarget = { headlineRnpvM: number; pApproval: number | null };

// Faithfulness tolerances — the assert compares the RECOMPUTED headline to the STORED one. The engine is
// deterministic, so a faithful restore matches to the floating-point ULP; these tolerances only absorb
// display-level rounding (the stored value is derived at full precision, so they're generous by design
// and a real corruption/stale-state divergence is orders of magnitude larger).
export const RESTORE_TOL_M = 0.5;   // $0.5M on the eNPV
export const RESTORE_TOL_P = 0.005; // 0.5 percentage-points on P(approval)

type RestorableRecord =
  | { schemaVersion?: number; _compute?: unknown; _governed?: unknown }
  | null
  | undefined;

/**
 * Version-guard decision (pure).
 *   "full"             — schema matches AND a compute snapshot + governed target are present → rehydrate
 *                        the pipeline state, let the pure engine recompute, then assertFaithful().
 *   "version-mismatch" — a schemaVersion is present but is NOT the current one → ignore compute state,
 *                        restore inputs only (never render another schema's numbers as current).
 *   "inputs-only"      — nothing to restore beyond inputs (legacy record with no schemaVersion, a manual
 *                        valuation with no dev plan, or a null record).
 */
export function classifyRestore(rec: RestorableRecord): "full" | "inputs-only" | "version-mismatch" {
  if (!rec) return "inputs-only";
  if (rec.schemaVersion !== undefined && rec.schemaVersion !== PERSIST_SCHEMA_VERSION) return "version-mismatch";
  if (rec.schemaVersion === PERSIST_SCHEMA_VERSION && rec._compute && rec._governed) return "full";
  return "inputs-only";
}

/**
 * Restore-faithfulness assert (pure). True iff the recomputed headline matches the stored one within
 * display rounding. A mismatch means the caller must NOT show the recomputed number as the saved result.
 */
export function assertFaithful(recomputed: GovernedTarget, stored: GovernedTarget): boolean {
  const rnpvOk = Math.abs(recomputed.headlineRnpvM - stored.headlineRnpvM) <= RESTORE_TOL_M;
  const pOk =
    stored.pApproval == null
      ? recomputed.pApproval == null
      : recomputed.pApproval != null && Math.abs(recomputed.pApproval - stored.pApproval) <= RESTORE_TOL_P;
  return rnpvOk && pOk;
}
