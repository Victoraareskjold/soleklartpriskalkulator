// Fasittester portert fra prototypen (soleklart-kalkulator-v1/tests/engine.test.mjs).
// Tallene her er godkjent mot skjermbilder av gammel kalkulator. Ikke endre dem uten avklaring.
import { describe, expect, it } from "vitest";
import { calculate, createSnapshot, toOre, validateTiers } from ".";
import type { CalculationInput, LineInput } from ".";

const line = (
  id: string,
  quantity: number,
  baseUnit: unknown,
  markupPercent = 0,
  extra: Partial<LineInput> = {},
): LineInput => ({ id, name: id, quantity, baseUnit, markupPercent, kind: "product", ...extra }) as LineInput;

const input = (lines: LineInput[], extra: Partial<CalculationInput> = {}): CalculationInput => ({
  lines,
  panelCount: lines
    .filter((l) => l.productKind === "panel")
    .reduce((total, l) => total + Number(l.quantity), 0),
  commission: { mode: "amount", value: 0 },
  reduction: { mode: "percent", value: 0 },
  ...extra,
});

describe("referanseanlegg", () => {
  it("LYN, 36 paneler gir 234 048 kr", () => {
    const r = calculate(
      input(
        [
          line("panel", 36, 840, 10, { productKind: "panel" }),
          line("mountkit", 36, 599, 10),
          line("inverter", 1, 9000, 10),
          line("scaffold", 1, 15000, 10),
          line("freight1", 1, 2000, 1),
          line("freight2", 1, 1000, 1),
          line("mount", 36, 1000, 20, { kind: "mount", reductionEligible: true }),
          line("application", 1, 2700, 32, { kind: "work" }),
          line("electrical", 1, 13500, 32, { kind: "work" }),
        ],
        { commission: { mode: "auto" } },
      ),
    );
    expect(r.totals.subtotal).toBe(15099840);
    expect(r.commission.amount).toBe(3623962);
    expect(r.totals.totalExVat).toBe(18723802);
    expect(Math.round(r.totals.totalIncVat / 100)).toBe(234048);
  });

  it("Alfa, 33 paneler gir 246 561 kr", () => {
    const r = calculate(
      input(
        [
          line("panels", 33, 840, 20, { productKind: "panel" }),
          line("kit", 33, 599, 20),
          line("inv", 1, 9000, 20),
          line("scaffold", 1, 15000, 20),
          line("freight", 1, 3000, 1),
          line("mount", 33, 1500, 15, { kind: "mount", reductionEligible: true }),
          line("work", 1, 10100, 32, { kind: "work" }),
        ],
        { commission: { mode: "auto" } },
      ),
    );
    expect(r.totals.subtotal).toBe(15907140);
    expect(Math.round(r.totals.totalIncVat / 100)).toBe(246561);
  });
});

describe("kommisjon", () => {
  it("trinngrensene er eksakte, uten paneler er 25 %", () => {
    for (const [n, percent] of [[0, 25], [1, 24], [55, 24], [56, 20], [200, 20], [201, 15], [500, 15], [501, 10]]) {
      const lines = n ? [line("p", n, 100, 0, { productKind: "panel" })] : [line("battery", 1, 100)];
      expect(calculate(input(lines, { commission: { mode: "auto" } })).commission.percent).toBe(percent);
    }
  });

  it("fast kommisjon står fast når grunnlaget endres, prosent følger grunnlaget", () => {
    for (const price of [100, 250]) {
      expect(calculate(input([line("x", 1, price)], { commission: { mode: "amount", value: 23.45 } })).commission.amount).toBe(2345);
    }
    expect(calculate(input([line("x", 1, 250)], { commission: { mode: "percent", value: 20 } })).commission.amount).toBe(5000);
  });

  it("manuelt 0 er noe annet enn automatisk standard", () => {
    const r = calculate(input([line("x", 1, 100)], { commission: { mode: "percent", value: 0 } }));
    expect(r.commission.amount).toBe(0);
  });
});

describe("volumrabatt", () => {
  it("gjelder bare montering, og trekkes før påslag per linje", () => {
    const r = calculate(
      input(
        [
          line("p", 72, 100, 0, { productKind: "panel" }),
          line("m", 72, 1000, 20, { kind: "mount", reductionEligible: true }),
          line("cable", 20, 150, 32, { kind: "work" }),
        ],
        { reduction: { mode: "auto" }, reductionTiers: [{ min: 72, max: 144, percent: 6 }] },
      ),
    );
    expect(r.lines[0].reduction).toBe(0);
    expect(r.lines[1].reduction).toBe(432000);
    expect(r.lines[1].sale).toBe(8121600);
    expect(r.lines[2].sale).toBe(396000);
  });

  it("fordeling mellom tak med ulikt påslag mister ingen øre", () => {
    const r = calculate(
      input(
        [
          line("a", 1, 0.01, 10, { kind: "mount", reductionEligible: true }),
          line("b", 1, 0.01, 20, { kind: "mount", reductionEligible: true }),
        ],
        { reduction: { mode: "amount", value: 0.01 } },
      ),
    );
    expect(r.lines.reduce((total, l) => total + l.reduction, 0)).toBe(1);
    expect(r.lines[0].reduction).toBe(1);
  });

  it("overlapp avvises, manglende øvre trinn blokkerer lagring", () => {
    expect(() => validateTiers([{ min: 0, max: 55, percent: 24 }, { min: 55, max: 200, percent: 20 }])).toThrow();
    const i = input(
      [
        line("p", 1001, 100, 0, { productKind: "panel" }),
        line("m", 1001, 100, 0, { kind: "mount", reductionEligible: true }),
      ],
      { reduction: { mode: "auto" }, reductionTiers: [{ min: 72, max: 1000, percent: 15 }] },
    );
    const r = calculate(i);
    expect(r.ready).toBe(false);
    expect(() => createSnapshot(i, r)).toThrow();
  });
});

describe("linjer og validering", () => {
  it("fast salgspris endrer aldri innkjøps-/arbeidsgrunnlaget", () => {
    const r = calculate(input([line("x", 2, 100, 20, { priceMode: "fixed", fixedSale: 190 })]));
    expect(r.lines[0].base).toBe(20000);
    expect(r.lines[0].sale).toBe(19000);
    expect(r.lines[0].markupAmount).toBe(-1000);
  });

  it("manglende, ugyldige og negative tall kan ikke bli gratis arbeid", () => {
    for (const value of [undefined, null, NaN, Infinity, "", "x", -1]) {
      expect(() => calculate(input([line("x", 1, value)]))).toThrow();
    }
    expect(() => calculate(input([line("p", 2, 100, 0, { productKind: "panel" })], { panelCount: 3 }))).toThrow();
    expect(() => calculate(input([line("a", 1, 100), line("a", 1, 100)]))).toThrow();
    expect(() => calculate(input([line("a", 1, 100)], { reduction: { mode: "amount", value: 10 } }))).toThrow();
  });

  it("desimaløre avrundes likt", () => {
    expect(toOre("1.005")).toBe(101);
    expect(toOre("0,29")).toBe(29);
    expect(calculate(input([line("meter", 1.5, 0.33)])).lines[0].base).toBe(50);
  });
});

describe("støtte og snapshot", () => {
  it("støtte vises separat og endrer ikke faktura eller kommisjon", () => {
    const i = input([line("b", 1, 1000)], { commission: { mode: "auto" } });
    const a = calculate(i);
    const b = calculate({ ...i, supportAmount: 100 });
    expect(a.totals.totalIncVat).toBe(b.totals.totalIncVat);
    expect(a.commission.amount).toBe(b.commission.amount);
    expect(a.totals.afterSupport - b.totals.afterSupport).toBe(10000);
  });

  it("snapshot er en dyp kopi av input og resultat", () => {
    const i = input([line("a", 1, 100)]);
    const r = calculate(i);
    const s = createSnapshot(i, r, { id: "v1" });
    i.lines[0].baseUnit = 999;
    r.lines[0].name = "changed";
    expect(s.input.lines[0].baseUnit).toBe(100);
    expect(s.result.lines[0].name).toBe("a");
  });
});

describe("API-eksempel (docs/API.md)", () => {
  it("batteri + installasjon uten paneler: 51 920 / 12 980 / 64 900 / 81 125 kr", () => {
    const r = calculate({
      currency: "NOK",
      panelCount: 0,
      lines: [
        { id: "battery-1", name: "Batteri", kind: "product", quantity: 1, unit: "system", baseUnit: "40000.00", markupPercent: "10", priceMode: "auto", reductionEligible: false },
        { id: "work-1", name: "Batteriinstallasjon", kind: "work", quantity: 1, unit: "system", baseUnit: "6000.00", markupPercent: "32", priceMode: "auto", reductionEligible: false },
      ],
      commission: { mode: "auto" },
      noPanelCommissionPercent: 25,
      reduction: { mode: "percent", value: 0 },
      vatPercent: 25,
      supportAmount: 0,
    });
    expect(r.totals.subtotal).toBe(5192000);
    expect(r.commission.amount).toBe(1298000);
    expect(r.totals.totalExVat).toBe(6490000);
    expect(r.totals.totalIncVat).toBe(8112500);
  });
});
