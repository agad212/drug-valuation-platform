import { describe, it, expect } from "vitest";
import {
  normalCDF,
  mixtureSuccessProbability,
  updateMixture,
  buildEffectPrior,
  mixtureFromMssVariance,
  mixtureMoments,
  BIMODAL_MIN_WEIGHT,
  MIN_SIGMA2,
  type EvidenceStepInput,
} from "../effect-prior";

describe("normalCDF", () => {
  it("returns 0.5 at z = 0", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
  });

  it("clamps to 0 and 1 far in the tails", () => {
    expect(normalCDF(-7)).toBe(0);
    expect(normalCDF(7)).toBe(1);
  });

  it("matches the standard reference value at z = 1.96", () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCDF(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe("mixtureSuccessProbability", () => {
  it("reduces exactly to the single-curve formula for a 1-component mixture", () => {
    const mixture = [{ w: 1, mu: 0.95, sigma2: 0.12 }];
    const threshold = 0.8;
    const sigma2Trial = 0.6;

    const z = (0.95 - threshold) / Math.sqrt(0.12 + sigma2Trial);
    expect(mixtureSuccessProbability(mixture, threshold, sigma2Trial)).toBeCloseTo(
      normalCDF(z),
      10
    );
  });

  it("is the weighted sum of each component's success probability for a 2-component mixture", () => {
    const mixture = [
      { w: 2 / 3, mu: 1.13, sigma2: 0.06 },
      { w: 1 / 3, mu: 0.3, sigma2: 0.12 },
    ];
    const threshold = 0.8;
    const sigma2Trial = 0.6;

    const z1 = (1.13 - threshold) / Math.sqrt(0.06 + sigma2Trial);
    const z2 = (0.3 - threshold) / Math.sqrt(0.12 + sigma2Trial);
    const expected = (2 / 3) * normalCDF(z1) + (1 / 3) * normalCDF(z2);

    expect(mixtureSuccessProbability(mixture, threshold, sigma2Trial)).toBeCloseTo(expected, 10);
  });
});

describe("mixtureFromMssVariance / mixtureMoments", () => {
  it("mixtureFromMssVariance wraps (mss, variance) as a 1-component mixture with mu = mss * 2", () => {
    expect(mixtureFromMssVariance(0.5, 0.3)).toEqual([{ w: 1, mu: 1.0, sigma2: 0.3 }]);
  });

  it("mixtureFromMssVariance floors sigma2 at MIN_SIGMA2", () => {
    const mixture = mixtureFromMssVariance(0.5, 0);
    expect(mixture[0].sigma2).toBe(MIN_SIGMA2);
  });

  it("round-trips through mixtureMoments for a 1-component mixture", () => {
    const mss = 0.62;
    const variance = 0.18;
    expect(mixtureMoments(mixtureFromMssVariance(mss, variance))).toEqual({ mss, variance });
  });

  it("mixtureMoments applies the law of total variance for a 2-component mixture", () => {
    const mixture = [
      { w: 0.6, mu: 1.2, sigma2: 0.1 },
      { w: 0.4, mu: 0.4, sigma2: 0.2 },
    ];
    const { mss, variance } = mixtureMoments(mixture);

    // muBar = 0.6*1.2 + 0.4*0.4 = 0.88 -> mss = muBar/2 = 0.44
    expect(mss).toBeCloseTo(0.44, 10);
    // within  = 0.6*0.1 + 0.4*0.2           = 0.14
    // between = 0.6*(1.2-0.88)^2 + 0.4*(0.4-0.88)^2 = 0.1536
    // variance = within + between = 0.2936
    expect(variance).toBeCloseTo(0.2936, 10);

    // The between-curve term means a bimodal mixture's collapsed variance is
    // strictly wider than either component's own sigma2 — reflecting the
    // coin-flip itself, not just within-curve uncertainty.
    expect(variance).toBeGreaterThan(0.2);
  });
});

describe("updateMixture", () => {
  it("agreement: merges into one narrower curve, pulled toward the more confident input", () => {
    const running = [{ w: 1, mu: 0.45, sigma2: 0.3 }];
    const signal = { mu: 0.48, sigma2: 0.2 };

    const result = updateMixture(running, signal);

    expect(result.agreement).toBe("agree");
    expect(result.mixture).toHaveLength(1);
    expect(result.mixture[0].mu).toBeCloseTo(0.468, 5);
    expect(result.mixture[0].sigma2).toBeCloseTo(0.12, 5);
    // Narrower than either input curve.
    expect(result.mixture[0].sigma2).toBeLessThan(0.2);
    expect(result.mixture[0].sigma2).toBeLessThan(0.3);
  });

  it("disagreement: splits into a 2-component mixture, weighted by relative precision", () => {
    const running = [{ w: 1, mu: 1.13, sigma2: 0.06 }];
    const signal = { mu: 0.3, sigma2: 0.12 };

    const result = updateMixture(running, signal);

    expect(result.agreement).toBe("disagree");
    expect(result.mixture).toHaveLength(2);

    const [existing, incoming] = result.mixture;
    expect(existing.mu).toBe(1.13);
    expect(existing.sigma2).toBe(0.06);
    expect(existing.w).toBeCloseTo(2 / 3, 5);

    expect(incoming.mu).toBe(0.3);
    expect(incoming.sigma2).toBe(0.12);
    expect(incoming.w).toBeCloseTo(1 / 3, 5);

    expect(existing.w + incoming.w).toBeCloseTo(1, 10);
    expect(existing.w).toBeGreaterThanOrEqual(BIMODAL_MIN_WEIGHT);
    expect(incoming.w).toBeGreaterThanOrEqual(BIMODAL_MIN_WEIGHT);
  });
});

describe("buildEffectPrior — full chain", () => {
  const antiAmyloidSteps: EvidenceStepInput[] = [
    {
      source: "mechanism",
      label: "Mechanism: amyloid-targeting mAb",
      found: true,
      signal: { mu: 1.1, sigma2: 0.15 },
      reasoning:
        "Strong target engagement and plaque-clearance data support a sizable effect, but mechanism alone leaves real uncertainty.",
    },
    {
      source: "animal",
      label: "Animal model: transgenic mouse efficacy",
      found: true,
      signal: { mu: 1.15, sigma2: 0.1 },
      reasoning: "Animal efficacy data closely tracks the mechanism prediction and tightens our confidence.",
    },
    {
      source: "analog",
      label: "Same-class analog: prior anti-amyloid Phase 3 readouts",
      found: true,
      signal: { mu: 0.3, sigma2: 0.12 },
      reasoning:
        "Multiple prior anti-amyloid antibodies in this class failed to show clinical benefit despite similar preclinical profiles — a sharp conflict with the mechanism+animal story.",
    },
  ];

  it("anti-amyloid case: mechanism+animal agree and tighten, then analog data conflicts sharply -> bimodal", () => {
    const result = buildEffectPrior(antiAmyloidSteps);

    // Step 0 (mechanism) seeds the mixture unchanged.
    expect(result.chain[0].mixtureAfter).toEqual([{ w: 1, mu: 1.1, sigma2: 0.15 }]);
    expect(result.chain[0].agreement).toBe("n/a");

    // Step 1 (animal) agrees and narrows the curve below both inputs' variance.
    expect(result.chain[1].agreement).toBe("agree");
    expect(result.chain[1].mixtureAfter).toHaveLength(1);
    expect(result.chain[1].mixtureAfter[0].mu).toBeCloseTo(1.13, 5);
    expect(result.chain[1].mixtureAfter[0].sigma2).toBeCloseTo(0.06, 5);
    expect(result.chain[1].mixtureAfter[0].sigma2).toBeLessThan(0.15);
    expect(result.chain[1].mixtureAfter[0].sigma2).toBeLessThan(0.1);

    // Step 2 (analog) sharply disagrees -> splits into two curves.
    expect(result.chain[2].agreement).toBe("disagree");
    expect(result.chain[2].mixtureAfter).toHaveLength(2);

    // Final shape is bimodal: a real coin-flip between two stories.
    expect(result.shape).toBe("bimodal");
    expect(result.mixture).toHaveLength(2);
    expect(result.mixture[0].w).toBeGreaterThanOrEqual(BIMODAL_MIN_WEIGHT);
    expect(result.mixture[1].w).toBeGreaterThanOrEqual(BIMODAL_MIN_WEIGHT);
  });

  const kio301Steps: EvidenceStepInput[] = [
    {
      source: "mechanism",
      label: "Mechanism: target validation review",
      found: true,
      signal: { mu: 0.9, sigma2: 0.2 },
      reasoning: "Moderate mechanistic support with typical uncertainty for an early-stage target.",
    },
    {
      source: "animal",
      label: "Animal model: efficacy study",
      found: true,
      signal: { mu: 0.95, sigma2: 0.15 },
      reasoning: "Animal data is consistent with the mechanism estimate and adds modest confidence.",
    },
    {
      source: "analog",
      label: "Same-target analog clinical data",
      found: false,
      reasoning: "No sufficiently similar analog programs were found for this target/modality combination.",
    },
    {
      source: "own_clinical",
      label: "Drug's own early clinical data",
      found: true,
      signal: { mu: 0.97, sigma2: 0.5 },
      reasoning:
        "A small early trial is broadly consistent with prior expectations, though the small sample size keeps its uncertainty wide.",
    },
  ];

  it("KIO-301-like case: agreement throughout, analog not found passes through unchanged -> stays unimodal", () => {
    const result = buildEffectPrior(kio301Steps);

    expect(result.chain[1].agreement).toBe("agree");

    // Step 2 (analog) not found -> passes the mixture through unchanged.
    expect(result.chain[2].found).toBe(false);
    expect(result.chain[2].agreement).toBe("n/a");
    expect(result.chain[2].mixtureBefore).toEqual(result.chain[2].mixtureAfter);

    expect(result.chain[3].agreement).toBe("agree");

    expect(result.shape).toBe("unimodal");
    expect(result.mixture).toHaveLength(1);
  });
});

describe("buildEffectPrior — chain history integrity", () => {
  it("chain snapshots are independent copies, not references to the running mixture", () => {
    const steps: EvidenceStepInput[] = [
      {
        source: "mechanism",
        label: "Mechanism",
        found: true,
        signal: { mu: 1.1, sigma2: 0.15 },
        reasoning: "seed",
      },
      {
        source: "animal",
        label: "Animal",
        found: true,
        signal: { mu: 1.15, sigma2: 0.1 },
        reasoning: "agrees",
      },
    ];

    const result = buildEffectPrior(steps);
    const finalMixtureSnapshot = JSON.parse(JSON.stringify(result.mixture));

    // Mutate chain snapshots directly.
    result.chain[1].mixtureAfter[0].mu = 9999;
    result.chain[0].mixtureAfter[0].sigma2 = -1;

    // The final mixture and other chain entries must be unaffected.
    expect(result.mixture).toEqual(finalMixtureSnapshot);
    expect(result.chain[1].mixtureBefore[0].sigma2).not.toBe(-1);
  });
});

describe("buildEffectPrior — input validation", () => {
  it("throws if given an empty steps array", () => {
    expect(() => buildEffectPrior([])).toThrow();
  });

  it("throws if the first step is not a found mechanism step", () => {
    const wrongSource: EvidenceStepInput[] = [
      {
        source: "animal",
        label: "Animal model",
        found: true,
        signal: { mu: 0.5, sigma2: 0.1 },
        reasoning: "wrong first source",
      },
    ];
    expect(() => buildEffectPrior(wrongSource)).toThrow();

    const mechanismNotFound: EvidenceStepInput[] = [
      {
        source: "mechanism",
        label: "Mechanism",
        found: false,
        reasoning: "no mechanism data",
      },
    ];
    expect(() => buildEffectPrior(mechanismNotFound)).toThrow();
  });
});
