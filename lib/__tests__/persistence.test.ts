import { describe, it, expect } from "vitest";
import {
  PERSIST_SCHEMA_VERSION,
  classifyRestore,
  assertFaithful,
  RESTORE_TOL_M,
  RESTORE_TOL_P,
  type GovernedTarget,
} from "../persistence";

describe("persistence — version guard (classifyRestore)", () => {
  it("FULL restore: current schema + compute snapshot + governed target present", () => {
    expect(
      classifyRestore({ schemaVersion: PERSIST_SCHEMA_VERSION, _compute: { devPlanStages: [] }, _governed: { headlineRnpvM: 100, pApproval: 0.2 } }),
    ).toBe("full");
  });

  it("VERSION-MISMATCH: a schemaVersion is present but is NOT the current one → ignore compute state", () => {
    // a future build's snapshot
    expect(classifyRestore({ schemaVersion: PERSIST_SCHEMA_VERSION + 1, _compute: {}, _governed: {} })).toBe("version-mismatch");
    // a corrupted/older marker
    expect(classifyRestore({ schemaVersion: 0, _compute: {}, _governed: {} })).toBe("version-mismatch");
  });

  it("INPUTS-ONLY: legacy record with no schemaVersion (pre-persistence save)", () => {
    expect(classifyRestore({ _patentResult: { foo: 1 } } as any)).toBe("inputs-only");
  });

  it("INPUTS-ONLY: current schema but no governed target (manual valuation / dev plan never computed)", () => {
    expect(classifyRestore({ schemaVersion: PERSIST_SCHEMA_VERSION, _compute: { devPlanStages: null } })).toBe("inputs-only");
    expect(classifyRestore({ schemaVersion: PERSIST_SCHEMA_VERSION, _compute: { devPlanStages: null }, _governed: null })).toBe("inputs-only");
  });

  it("INPUTS-ONLY: null / undefined record", () => {
    expect(classifyRestore(null)).toBe("inputs-only");
    expect(classifyRestore(undefined)).toBe("inputs-only");
  });
});

describe("persistence — restore-faithfulness assert (assertFaithful)", () => {
  const stored: GovernedTarget = { headlineRnpvM: 248.0, pApproval: 0.17 };

  it("PASSES on a byte-identical recompute (deterministic engine → same inputs → same headline)", () => {
    expect(assertFaithful({ headlineRnpvM: 248.0, pApproval: 0.17 }, stored)).toBe(true);
  });

  it("PASSES within display rounding (recompute equals full-precision stored value up to tolerance)", () => {
    // Comfortably inside tolerance (half the band) — a faithful recompute only ever differs by display
    // rounding, which is far below these; exact-boundary values are avoided (float representation).
    expect(assertFaithful({ headlineRnpvM: 248.0 + RESTORE_TOL_M / 2, pApproval: 0.17 + RESTORE_TOL_P / 2 }, stored)).toBe(true);
  });

  it("FAILS when the recomputed eNPV diverges beyond tolerance (corrupt/stale state)", () => {
    expect(assertFaithful({ headlineRnpvM: 3.0, pApproval: 0.17 }, stored)).toBe(false); // the $3M-style divergence
    expect(assertFaithful({ headlineRnpvM: -710.0, pApproval: 0.17 }, stored)).toBe(false); // the pre-fix out.* number
  });

  it("FAILS when P(approval) diverges beyond tolerance", () => {
    expect(assertFaithful({ headlineRnpvM: 248.0, pApproval: 0.30 }, stored)).toBe(false);
  });

  it("handles the no-dev-plan case: null pApproval matches only null", () => {
    const noPlan: GovernedTarget = { headlineRnpvM: 50, pApproval: null };
    expect(assertFaithful({ headlineRnpvM: 50, pApproval: null }, noPlan)).toBe(true);
    expect(assertFaithful({ headlineRnpvM: 50, pApproval: 0.2 }, noPlan)).toBe(false); // recompute gained a plan → not faithful
    expect(assertFaithful({ headlineRnpvM: 50, pApproval: null }, { headlineRnpvM: 50, pApproval: 0.2 })).toBe(false); // lost a plan → not faithful
  });
});
