import { describe, expect, it } from "vitest";
import { calculate, type LineInput } from "@/lib/engine";
import { toLegacyPriceData } from "./legacy";

const line = (id: string, kind: LineInput["kind"], quantity: number, baseUnit: number, markupPercent: number, meta: Record<string, unknown>, extra: Partial<LineInput> = {}): LineInput => ({
  // Som i build.ts: linjens navn er produktnavnet, med mindre det er endret i tilbudet
  id, name: (meta.productName as string | undefined) ?? id, kind, quantity, baseUnit, markupPercent, meta: { source: "catalog", overridden: [], ...meta }, ...extra,
});

describe("price_data i gammelt format", () => {
  const result = calculate({
    panelCount: 36,
    commission: { mode: "auto" },
    reduction: { mode: "percent", value: 0 },
    lines: [
      line("panel", "product", 36, 840, 10, { category: "solcellepanel", productName: "Astronergy 460Wp", supplier: "Nordic" }, { productKind: "panel" }),
      line("kit", "product", 36, 599, 10, { category: "feste", productName: "Takstein - VG Solar", supplier: "STS" }),
      line("inv", "product", 1, 9000, 10, { category: "inverter", productName: "Deye 15kW", attachmentUrl: "https://x/datablad.pdf" }),
      line("mount", "mount", 36, 1000, 20, { category: "montering", roofTypeName: "Takstein (Dobbelkrummet)" }, { reductionEligible: true }),
      line("doc", "work", 1, 1500, 32, { workGroup: "søknad" }),
      line("msg", "work", 1, 1200, 32, { workGroup: "søknad" }),
      line("dc", "work", 10, 150, 32, { workGroup: "tillegg" }),
      line("egen", "work", 1, 500, 32, { source: "custom" }),
    ],
  });
  const data = toLegacyPriceData(result, { quoteVersionId: "v1" });

  it("produkter og montering i hver sin liste, med kategori og produktnavn", () => {
    expect(data.suppliers.map((s) => s.category)).toEqual(["solcellepanel", "feste", "inverter"]);
    expect(data.suppliers[0].product).toBe("Astronergy 460Wp");
    expect(data.suppliers[0].priceWithMarkup).toBe(33264); // 36 × 840 × 1,10
    expect(data.suppliers[2].attachmentUrl).toBe("https://x/datablad.pdf");
    expect(data.mounting).toHaveLength(1);
    expect(data.mounting[0].product).toBe("Takstein (Dobbelkrummet)");
  });

  it("arbeid summeres per gruppe, tillegg og egendefinert blir additionalCosts", () => {
    expect(data.installation.søknad.priceWithMarkup).toBe(3564); // 2700 × 1,32
    expect(data.installation.solcelleAnlegg.priceWithMarkup).toBe(0);
    expect(data.installation.additionalCosts.map((a) => a.id)).toEqual(["dc", "egen"]);
  });

  it("total er eks. mva. inkl. provisjon; provisjon = total − sum av linjene", () => {
    const lines = [...data.suppliers, ...data.mounting].reduce((s, l) => s + l.priceWithMarkup, 0) +
      data.installation.søknad.priceWithMarkup + data.installation.solcelleAnlegg.priceWithMarkup +
      data.installation.battery.priceWithMarkup + data.installation.additionalCosts.reduce((s, a) => s + a.priceWithMarkup, 0);
    expect(Math.round(lines * 100)).toBe(result.totals.subtotal);
    expect(Math.round((data.total - lines) * 100)).toBe(result.commission.amount);
    expect(data["total inkl. alt"]).toBe(result.totals.totalIncVat / 100);
    expect(data.quoteVersionId).toBe("v1");
  });
});

describe("endret tekst på en linje", () => {
  it("kundesiden viser teksten fra tilbudet, ikke katalognavnet", () => {
    const result = calculate({
      panelCount: 0,
      commission: { mode: "percent", value: 0 },
      reduction: { mode: "percent", value: 0 },
      lines: [line("inv", "product", 1, 9000, 10, { category: "inverter", productName: "Deye 15kW" }, { name: "Deye 15kW (levert av STS)" })],
    });
    expect(toLegacyPriceData(result).suppliers[0].product).toBe("Deye 15kW (levert av STS)");
  });
});
