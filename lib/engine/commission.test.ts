// Soleklart-kommisjon på hele grunnlaget og avtalt sluttsum (Asbjørns merknader 17.10.2026).
import { describe, expect, it } from "vitest";
import { calculate, type CalculationInput } from ".";

const base = (extra: Partial<CalculationInput> = {}): CalculationInput => ({
  panelCount: 0,
  reduction: { mode: "percent", value: 0 },
  vatPercent: 25,
  lines: [
    { id: "sol", name: "Solcelleanlegg", kind: "product", quantity: 1, baseUnit: 100_000, markupPercent: 0 },
    { id: "bat", name: "Batteripakke med installasjon", kind: "product", quantity: 1, baseUnit: 230_000, markupPercent: 0 },
  ],
  ...extra,
});

describe("Soleklart-kommisjon", () => {
  it("legges én gang på hele grunnlaget: 330 000 × 24 % = 79 200, totalt 409 200 kr", () => {
    const r = calculate(base({ commission: { mode: "percent", value: 24 } }));
    expect(r.totals.subtotal).toBe(33_000_000);
    expect(r.commission.amount).toBe(7_920_000);
    expect(r.totals.totalExVat).toBe(40_920_000);
  });

  it("avtalt sluttsum eks. mva. gir kommisjon = sluttsum − sum før Soleklart", () => {
    const r = calculate(base({ commission: { mode: "total", value: "400000" } }));
    expect(r.totals.totalExVat).toBe(40_000_000);
    expect(r.commission.amount).toBe(7_000_000);
    expect(r.commission.percent).toBeNull();
    expect(r.totals.totalIncVat).toBe(50_000_000);
  });

  it("avtalt sluttsum under installatørens grunnlag avvises", () => {
    expect(() => calculate(base({ commission: { mode: "total", value: "300000" } }))).toThrow(/lavere enn summen/);
  });

  it("volumrabatt kan ikke bruke sluttsum-modus", () => {
    expect(() => calculate(base({ commission: { mode: "auto" }, reduction: { mode: "total", value: 1 } }))).toThrow();
  });
});
