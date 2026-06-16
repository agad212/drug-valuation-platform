// /api/effect-prior
//
// Orchestrator for the True Effect Prior evidence-integration engine.
// Takes the drug's basic info plus the already-computed Layer 1 mechanism
// result (mss, variance, summary), runs the three AI evidence-discovery
// calls (animal, analog, own clinical) in parallel, and folds all four
// evidence steps into a Gaussian-mixture EffectPrior via buildEffectPrior().

import type { NextApiRequest, NextApiResponse } from "next";
import {
  buildMechanismStep,
  discoverAnimalEvidence,
  discoverAnalogEvidence,
  discoverOwnClinicalEvidence,
  type EvidenceContext,
} from "../../lib/evidence-discovery";
import { buildEffectPrior, mixtureSuccessProbability } from "../../lib/effect-prior";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { drug, mechanism, indication, phase, sponsor, nctId } = req.body;
  if (!drug || typeof drug !== "string") return res.status(400).json({ error: "drug required" });
  if (
    !mechanism ||
    typeof mechanism.mss !== "number" ||
    typeof mechanism.variance !== "number" ||
    typeof mechanism.summary !== "string"
  ) {
    return res.status(400).json({ error: "mechanism (with mss, variance, summary) required" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  try {
    const mechanismStep = buildMechanismStep(mechanism);
    const ctx: EvidenceContext = {
      drug,
      indication,
      phase,
      sponsor,
      nctId,
      mechanismSummary: mechanism.summary,
    };

    const [animalStep, analogStep, ownClinicalStep] = await Promise.all([
      discoverAnimalEvidence(ctx, anthropicKey),
      discoverAnalogEvidence(ctx, anthropicKey),
      discoverOwnClinicalEvidence(ctx, anthropicKey),
    ]);

    const effectPrior = buildEffectPrior([mechanismStep, animalStep, analogStep, ownClinicalStep]);

    return res.status(200).json({
      effectPrior,
      _previewProbability: mixtureSuccessProbability(effectPrior.mixture, 0.8, 0.6),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Effect prior build failed" });
  }
}
