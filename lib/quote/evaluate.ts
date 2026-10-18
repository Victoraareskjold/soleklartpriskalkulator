import "server-only";
import { calculate } from "@/lib/engine";
import { buildEngineInput } from "./build";
import type { Draft } from "./draft";
import { computeBatteryOffer } from "./batteryLoader";
import { toLegacyPriceData } from "./legacy";
import type { BatteryOfferResult } from "./battery";
import type { CalculationResult } from "@/lib/engine";

import { economyFor, type EconomyDefaults } from "./economy";
export type { EconomyDefaults };

/** Regner et utkast helt: grunnkalkyle, batteritillegg og standardverdier. */
export async function evaluateDraft(draft: Draft, installer: { id: string; teamId: string }) {
  const built = await buildEngineInput(draft, installer);
  const result = calculate(built.input);
  const settings = built.rules.settings;
  const batteryOffer = draft.batteryOffer
    ? await computeBatteryOffer(draft.batteryOffer, installer, settings, draft.grid ?? "230", built.kwp, result)
    : null;
  // Låses med tilbudet (gjelder når det er signert). Usignerte tilbud henter gjeldende verdier.
  const economy: EconomyDefaults = economyFor(settings, draft.customerType);
  return { built, result, batteryOffer, economy };
}

/** Det som lagres i den låste versjonens input (internt; vises aldri for kunden). */
export const versionInput = (e: Awaited<ReturnType<typeof evaluateDraft>>) => ({
  ...e.built.input,
  rules: e.built.rules,
  kwp: e.built.kwp,
  batteryOffer: e.batteryOffer,
  economy: e.economy,
});

/**
 * price_data i dagens format, pluss det kundesiden trenger fra den nye kalkulatoren:
 * batterySection (kundepriser inkl. Soleklart) og economy (standardverdier).
 */
export function priceDataFor(
  result: CalculationResult,
  input: { batteryOffer?: BatteryOfferResult | null; economy?: EconomyDefaults } | null,
  options: { quoteVersionId?: string; simulationPdfUrl?: string | null; keepBatterySection?: unknown },
) {
  const section = input?.batteryOffer?.section ?? options.keepBatterySection ?? null;
  return {
    ...toLegacyPriceData(result, { quoteVersionId: options.quoteVersionId, simulationPdfUrl: options.simulationPdfUrl }),
    ...(section ? { batterySection: section } : {}),
    ...(input?.economy ? { economy: input.economy } : {}),
  };
}
