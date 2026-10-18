import { describe, expect, it } from "vitest";
import type { Settings } from "@/lib/server/settings";
import { economyFor } from "./economy";

// Bare feltene economyFor leser (settings.ts er server-only og kan ikke importeres i test)
const DEFAULT_SETTINGS = {
  economy: { private: { elPrice: 0.56, netPrice: 0.62 }, business: { elPrice: 0.56, netPrice: 0.62 }, priceGrowthPercent: 2.5 },
  offerAssumptions: {},
} as unknown as Settings;

describe("forutsetninger for tilbudet", () => {
  it("standardverdier: 30 år, salgspris 0,60, automatisk egenbruk", () => {
    const e = economyFor(DEFAULT_SETTINGS, "private");
    expect(e).toMatchObject({ elPrice: 0.56, netPrice: 0.62, priceGrowthPercent: 2.5, exportPrice: 0.6, selfUsePercent: null, periodYears: 30, replacementYear: 15 });
  });
  it("verdier fra Beregningsregler vinner, og næring får næringspris", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      economy: { ...DEFAULT_SETTINGS.economy, business: { elPrice: 1.18, netPrice: 0.3 } },
      offerAssumptions: { exportPrice: 0.45, selfUsePercent: 40, periodYears: 20 },
    };
    expect(economyFor(settings, "business")).toMatchObject({ elPrice: 1.18, netPrice: 0.3, exportPrice: 0.45, selfUsePercent: 40, periodYears: 20, degradationPercent: 0.4 });
  });
});
