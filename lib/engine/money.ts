// Eksakt desimalregning med BigInt. Ingen flyttall i pengeberegninger.
import { CalculationError } from "./errors";
import type { Decimal, Ore } from "./types";

/** Brøk n/d, der d er en tierpotens. */
type Fraction = { n: bigint; d: bigint };

const DECIMAL_PATTERN = /^-?\d+(\.\d{1,6})?$/;

/** Tolker "1234,5" / "1234.5" / 1234.5 som eksakt brøk. Maks seks desimaler. */
export function parseDecimal(value: unknown, field = "value"): Fraction {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new CalculationError("Tall mangler", field);
  }
  const text = String(value).trim().replace(",", ".");
  if (!DECIMAL_PATTERN.test(text)) {
    throw new CalculationError("Ugyldig tall (maks. seks desimaler)", field);
  }
  const negative = text.startsWith("-");
  const [whole, decimals = ""] = text.replace("-", "").split(".");
  const n = BigInt(whole + decimals) * (negative ? -1n : 1n);
  return { n, d: 10n ** BigInt(decimals.length) };
}

/** n/d avrundet til nærmeste heltall. Halve avrundes bort fra null. */
function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new CalculationError("Ugyldig nevner");
  if (n < 0n) return -roundDiv(-n, d);
  return (n + d / 2n) / d;
}

function toSafeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new CalculationError("Beløpet er for stort", field);
  }
  return result;
}

/** Kroner → øre. */
export function toOre(value: Decimal, field = "amount"): Ore {
  const { n, d } = parseDecimal(value, field);
  return toSafeNumber(roundDiv(n * 100n, d), field);
}

/** Prosent av et øre-beløp, avrundet til øre. */
export function percentOf(amount: Ore, percent: Decimal, field: string): Ore {
  const { n, d } = parseDecimal(percent, field);
  return toSafeNumber(roundDiv(BigInt(amount) * n, 100n * d), field);
}

/** Øre-beløp × mengde (kan ha desimaler, f.eks. meter), avrundet til øre. */
export function multiply(amount: Ore, quantity: Decimal, field: string): Ore {
  const { n, d } = parseDecimal(quantity, field);
  return toSafeNumber(roundDiv(BigInt(amount) * n, d), field);
}

/** amount × numerator / denominator, avrundet til øre. */
export function scale(amount: Ore, numerator: Ore, denominator: Ore, field: string): Ore {
  if (denominator === 0) return 0;
  return toSafeNumber(roundDiv(BigInt(amount) * BigInt(numerator), BigInt(denominator)), field);
}

/** Validerer at verdien er et gyldig, ikke-negativt tall og returnerer det som number. */
export function nonNegative(value: unknown, field: string): number {
  const { n } = parseDecimal(value, field);
  if (n < 0n) throw new CalculationError("Verdien kan ikke være negativ", field);
  return Number(String(value).replace(",", "."));
}

export function sum(values: Ore[]): Ore {
  return toSafeNumber(
    values.reduce((total, value) => total + BigInt(value), 0n),
    "sum",
  );
}

/**
 * Fordeler `total` øre etter vekter med største-rest-metoden, slik at ingen øre forsvinner.
 * Ved lik rest vinner linjen som kommer først.
 */
export function allocate(total: Ore, weights: Ore[]): Ore[] {
  if (total === 0) return weights.map(() => 0);

  const denominator = BigInt(sum(weights));
  if (denominator === 0n) {
    throw new CalculationError("Rabatt uten monteringsgrunnlag");
  }

  const parts = weights.map((weight, index) => {
    const share = BigInt(weight) * BigInt(total);
    return { index, value: Number(share / denominator), remainder: share % denominator };
  });

  const left = total - sum(parts.map((part) => part.value));
  [...parts]
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    )
    .slice(0, left)
    .forEach((part) => part.value++);

  return parts.map((part) => part.value);
}
