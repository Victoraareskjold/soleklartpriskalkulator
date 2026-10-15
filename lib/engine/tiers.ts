import { CalculationError } from "./errors";
import { nonNegative } from "./money";
import type { Tier } from "./types";

/** Standard Soleklart-kommisjon etter panelantall. */
export const DEFAULT_COMMISSION_TIERS: Tier[] = [
  { min: 1, max: 55, percent: 24 },
  { min: 56, max: 200, percent: 20 },
  { min: 201, max: 500, percent: 15 },
  { min: 501, max: null, percent: 10 },
];

export const DEFAULT_NO_PANEL_COMMISSION_PERCENT = 25;

/** Sorterer og validerer trinn. Grensene er inklusive og kan ikke overlappe. */
export function validateTiers(tiers: Tier[], field = "tiers"): Tier[] {
  if (!Array.isArray(tiers)) throw new CalculationError("Trinn må være en liste", field);

  const sorted = [...tiers].sort((a, b) => a.min - b.min);

  sorted.forEach((tier, index) => {
    const validMin = Number.isInteger(tier.min) && tier.min >= 0;
    const validMax =
      tier.max === null || (Number.isInteger(tier.max) && tier.max >= tier.min);
    if (!validMin || !validMax) throw new CalculationError("Ugyldige intervallgrenser", field);

    if (nonNegative(tier.percent, field) > 100) {
      throw new CalculationError("Satsen kan ikke overstige 100 %", field);
    }

    const previous = sorted[index - 1];
    if (previous && (previous.max === null || tier.min <= previous.max)) {
      throw new CalculationError("Intervallene overlapper", field);
    }
  });

  return sorted;
}

export function findTier(count: number, tiers: Tier[], field: string): Tier | undefined {
  return validateTiers(tiers, field).find(
    (tier) => count >= tier.min && (tier.max === null || count <= tier.max),
  );
}
