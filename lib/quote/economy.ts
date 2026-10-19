// Forutsetningene i tilbudets økonomiberegning (pvwebsites offerEconomics.js).
// Settes sentralt under Beregningsregler. Usignerte tilbud bruker gjeldende verdier,
// signerte tilbud verdiene som ble låst da tilbudet ble laget (price_data.economy).
import type { OfferAssumptions, Settings } from "@/lib/server/settings";

export interface EconomyDefaults extends Required<Omit<OfferAssumptions, "selfUsePercent">> {
  /** Strømpris kr/kWh (privat eller næring etter kunden) */
  elPrice: number;
  /** Nettleie, energiledd kr/kWh */
  netPrice: number;
  /** Årlig prisvekst % */
  priceGrowthPercent: number;
  /** Andel av solstrømmen kunden bruker selv (%). null = anslås fra produksjon og forbruk */
  selfUsePercent: number | null;
}

export const ASSUMPTION_DEFAULTS: Required<Omit<OfferAssumptions, "selfUsePercent">> & { selfUsePercent: number | null } = {
  exportPrice: 0.6,
  selfUsePercent: null,
  degradationPercent: 0.4,
  replacementYear: 15,
  replacementFactor: 1.4,
  maintenancePerYear: 0,
  consumptionFallback: 20000,
  periodYears: 30,
  productWarrantyYears: 25,
  powerWarrantyYears: 30,
  expectedLifetimeYears: 40,
};

export function economyFor(settings: Settings, customerType: "private" | "business"): EconomyDefaults {
  const e = customerType === "business" ? settings.economy.business : settings.economy.private;
  const a = { ...ASSUMPTION_DEFAULTS, ...stripNulls(settings.offerAssumptions) };
  return {
    elPrice: e.elPrice,
    netPrice: e.netPrice,
    priceGrowthPercent: settings.economy.priceGrowthPercent,
    exportPrice: a.exportPrice,
    selfUsePercent: settings.offerAssumptions?.selfUsePercent ?? null,
    degradationPercent: a.degradationPercent,
    replacementYear: a.replacementYear,
    replacementFactor: a.replacementFactor,
    maintenancePerYear: a.maintenancePerYear,
    consumptionFallback: a.consumptionFallback,
    periodYears: a.periodYears,
    productWarrantyYears: a.productWarrantyYears,
    powerWarrantyYears: a.powerWarrantyYears,
    expectedLifetimeYears: a.expectedLifetimeYears,
  };
}

function stripNulls<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
