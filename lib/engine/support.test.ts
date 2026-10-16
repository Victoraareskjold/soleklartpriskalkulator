// Støtteregel (Enova for privatkunder), etter Asbjørns merknad 6 (15.10.2026).
import { describe, expect, it } from "vitest";
import { calculate, type CalculationInput, type LineInput } from ".";

const ENOVA = { mode: "auto" as const, provider: "Enova", percent: 25, perKwp: 2500, maxKwp: 15, maxAmount: 37500 };

/** Én støtteberettiget linje som gir eksakt `incVat` kr inkl. 25 % mva., uten kommisjon. */
const solar = (incVat: number, kwp: number, extraLines: LineInput[] = []): CalculationInput => ({
  panelCount: 0,
  commission: { mode: "amount", value: 0 },
  reduction: { mode: "percent", value: 0 },
  vatPercent: 25,
  lines: [{ id: "solar", name: "Solcelleanlegg", kind: "product", quantity: 1, baseUnit: incVat / 1.25, markupPercent: 0, supportEligible: true }, ...extraLines],
  support: { ...ENOVA, kwp },
});

describe("Enova-støtte for privatkunder", () => {
  it.each([
    // kWp, kostnad inkl. mva., forventet støtte (Asbjørns regneeksempler)
    [10, 80_000, 20_000], // 25 % er lavest
    [10, 200_000, 25_000], // kWp × 2 500 er lavest
    [20.24, 300_000, 37_500], // maks 15 kWp / 37 500 kr
  ])("%s kWp og %s kr gir %s kr", (kwp, cost, expected) => {
    const r = calculate(solar(cost, kwp));
    expect(r.totals.support).toBe(expected * 100);
    expect(r.support.eligibleBaseIncVat).toBe(cost * 100);
  });

  it("viser alle tre grensene, og prosent og kWp-beløp legges ikke sammen", () => {
    const r = calculate(solar(300_000, 20.24));
    expect(r.support.byPercent).toBe(7_500_000);
    expect(r.support.byKwp).toBe(3_750_000); // 15 kWp × 2 500
    expect(r.support.cap).toBe(3_750_000);
  });

  it("batteri og andre ikke-støtteberettigede linjer holdes utenfor grunnlaget", () => {
    const battery: LineInput = { id: "bat", name: "Batteri", kind: "product", quantity: 1, baseUnit: 80_000, markupPercent: 0 };
    const r = calculate(solar(80_000, 10, [battery]));
    expect(r.support.eligibleBaseIncVat).toBe(8_000_000);
    expect(r.totals.support).toBe(2_000_000);
  });

  it("støtteberettiget grunnlag tar med sin andel av kommisjonen", () => {
    const i = solar(80_000, 10, [{ id: "bat", name: "Batteri", kind: "product", quantity: 1, baseUnit: 64_000, markupPercent: 0 }]);
    const r = calculate({ ...i, commission: { mode: "percent", value: 10 } });
    // Halvparten av salget er støtteberettiget → halvparten av totalen inkl. mva.
    expect(r.support.eligibleBaseIncVat).toBe(r.totals.totalIncVat / 2);
  });

  it("støtte endrer aldri faktura, mva. eller kommisjon", () => {
    const withSupport = calculate(solar(200_000, 10));
    const without = calculate({ ...solar(200_000, 10), support: { mode: "none" } });
    expect(withSupport.totals.totalIncVat).toBe(without.totals.totalIncVat);
    expect(withSupport.totals.vat).toBe(without.totals.vat);
    expect(withSupport.commission.amount).toBe(without.commission.amount);
    expect(withSupport.totals.afterSupport).toBe(without.totals.totalIncVat - 2_500_000);
    expect(without.totals.support).toBe(0);
  });

  it("manuelt anslag (f.eks. næring) med valgfri støttegiver", () => {
    const r = calculate({ ...solar(200_000, 10), support: { mode: "manual", amount: "12500", provider: "Innovasjon Norge" } });
    expect(r.totals.support).toBe(1_250_000);
    expect(r.support.provider).toBe("Innovasjon Norge");
    expect(r.support.byPercent).toBeNull();
  });

  it("kWp med mange desimaler (36 × 0,46) godtas", () => {
    expect(() => calculate(solar(100_000, 36 * 0.46))).not.toThrow();
  });
});
