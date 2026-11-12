// DC-lader med salg til kjøretøy, Enova/nettoinvestering og kontroll mot Nordic Solergys analyse
// for Transportformidlingen (26.10.2026). Timeberegningen kan ikke sammenlignes direkte uten deres
// forbruksfil og timeverdier; her kontrolleres regnestykkene og hvordan de settes sammen.
import { describe, expect, test } from "vitest";
import { runAnalysis, type AnalysisInput, type ChargeSaleInput } from "../analysis";
import { lifetimeFrom, type EconomyInput } from "../economy";
import type { EngineResult } from "../engine";
import { chargeSaleProfile } from "../profiles";
import { chargeVolumeFromShare, investmentBasis } from "../basis";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { osloParts } from "../time";

describe("Transportformidlingen: regnestykkene i referansen", () => {
  const sold = 208_800, price = 3.5, toGrid = 107_361, costUp = 188_255, investment = 1_937_000;

  test("ladesalg og samlet gevinst år 1", () => {
    expect(sold * price).toBe(730_800);
    expect(730_800 + toGrid - costUp).toBe(649_906);
    // 3,00 kr/kWh: inntekt og gevinst faller begge med 104 400 kr
    expect(sold * 3.0).toBe(730_800 - 104_400);
  });

  test("ladevolum: 400 kW kl. 10–12 mandag–fredag i 2026 = 261 dager = 208 800 kWh", () => {
    const p = chargeSaleProfile(2026, { powerKw: 400, weekdays: [1, 2, 3, 4, 5], window: [10, 12], skipHolidays: false, utilizationPct: 100 });
    expect(p.days).toBe(261);
    expect(p.kwh).toBe(208_800);
    // Andel av samlet forbruk: 208 800 / (140 001 + 208 800) ≈ 59,86 %
    expect((sold / (140_001 + sold)) * 100).toBeCloseTo(59.86, 2);
    expect(chargeVolumeFromShare(140_001, (sold / (140_001 + sold)) * 100)).toBeCloseTo(sold, 6);
  });

  // Økonomien fra årets komponenter: før/etter som motoren ville gitt dem
  const fake = (netto: number, salg: number): EngineResult =>
    ({
      months: [],
      total: { cost: { kraft: netto + salg, kraftGebyr: 0, fastledd: 0, energiledd: 0, effektledd: 0, elavgift: 0, innmating: 0, salg, netto }, pvKwh: 163_237 },
      checks: { maxBalanceErrorKwh: 0, intervals: 8760 },
      tariffNotes: { notes: [], missing: [], shiftedFrom: [] },
    }) as unknown as EngineResult;
  const before = fake(181_085, 0);
  const after = fake(181_085 + costUp - toGrid, toGrid);
  const eco = (g: number, ladeVekst: number, chargePrice = price): EconomyInput => ({
    investmentNok: investment,
    years: 30,
    discountRate: 0.06,
    growth: { kraft: g, nettleie: g, avgift: g, drift: 0 },
    degradationPerYear: 0,
    opex: [],
    replacements: [],
    revenues: [{ name: "Ladesalg", nokPerYear: sold * chargePrice, growth: ladeVekst }],
  });

  test("første år og tilbakebetaling – hva forklarer 3,1 år", () => {
    const fixedPrice = lifetimeFrom(before, () => after, eco(0.045, 0));
    expect(fixedPrice.firstYearNet).toBeCloseTo(649_906, 0);
    // Investering / gevinst år 1 alene
    expect(investment / 649_906).toBeCloseTo(2.98, 2);
    // Ladeprisen fast, strøm og nettleie +4,5 %/år: kostnadsøkningen vokser raskere enn salget til nett
    expect(fixedPrice.paybackYears!).toBeCloseTo(3.0, 1);
    // Alt (også ladeprisen) +4,5 %/år: 2,86 år
    const allGrow = lifetimeFrom(before, () => after, eco(0.045, 0.045));
    expect(allGrow.paybackYears!).toBeCloseTo(2.86, 2);
    // Diskontert med 6 %: 3,2–3,4 år
    expect(allGrow.discountedPaybackYears!).toBeGreaterThan(3.1);
    // NPV 30 år: referansen oppgir 12 413 558 kr. Fast ladepris gir om lag halvparten; vekst i ladeprisen trengs.
    expect(fixedPrice.npv!).toBeLessThan(7_000_000);
    expect(allGrow.npv!).toBeGreaterThan(12_413_558);
  });

  test("ny salgspris endrer inntekt og tilbakebetaling, ikke kWh", () => {
    const a = lifetimeFrom(before, () => after, eco(0.045, 0, 3.5));
    const b = lifetimeFrom(before, () => after, eco(0.045, 0, 3.0));
    expect(a.firstYearNet - b.firstYearNet).toBeCloseTo(104_400, 0);
    expect(b.paybackYears!).toBeGreaterThan(a.paybackYears!);
  });
});

describe("investering etter støtte", () => {
  test("2 000 000 kr og 300 000 kr i støtte gir 1 700 000 kr", () => {
    const r = investmentBasis(2_000_000, { source: "tilbud", nok: null }, 300_000, "ja");
    expect(r).toMatchObject({ grossNok: 2_000_000, supportNok: 300_000, netNok: 1_700_000, vat: "eks" });
    expect(investmentBasis(2_000_000, { source: "ingen", nok: null }, 300_000, "ja").netNok).toBe(2_000_000);
    expect(investmentBasis(2_000_000, { source: "manuell", nok: 250_000 }, 300_000, "ja").netNok).toBe(1_750_000);
    // Uten fradragsrett: mva. på tilbudssummen, støtten trekkes fra etterpå (én gang)
    expect(investmentBasis(2_000_000, { source: "tilbud", nok: null }, 300_000, "nei").netNok).toBe(2_200_000);
  });
});

describe("analyse med DC-lader", () => {
  const spot = yearSeries(2024, "pris", (t) => {
    const h = osloParts(t).hour;
    return h < 6 ? 0.4 : h >= 7 && h < 10 ? 1.3 : h >= 17 && h < 21 ? 1.5 : 0.9;
  });
  const prof = chargeSaleProfile(2024, { powerKw: 200, weekdays: [1, 2, 3, 4, 5], window: [10, 12], skipHolidays: false, utilizationPct: 100 });
  const sale = (price = 3.5): ChargeSaleInput => ({
    label: "DC-lader",
    series: prof.series,
    soldKwhPerYear: prof.kwh,
    priceNokPerKwh: price,
    priceGrowth: 0,
    existingKwh: 0,
    existingPriceNokPerKwh: price,
    investmentNok: 500_000,
    opexNokPerYear: 0,
    basis: [],
  });
  const base = (price = 3.5): AnalysisInput => ({
    project: { name: "T", address: "x", priceArea: "NO1", businessType: "lager" },
    meteringPoint: { id: "m1", label: "Hovedmåler" },
    period: { kind: "år", year: 2024 },
    consumption: { level: 1, type: "lager", annualKwh: 140_000 },
    production: fakePv(2024, 189),
    spot,
    tariff: T, taxes, buy, sell, exportLimitKw: null,
    weatherYear: 2024,
    chargeSale: sale(price),
    economy: { investmentNok: 1_000_000, years: 30, discountRate: 0.06, growth: { kraft: 0.045, nettleie: 0.045, avgift: 0, drift: 0 }, degradationPerYear: 0, opex: [], replacements: [] },
    scenarios: [{ name: "Hoved", kraftGrowth: 0.045 }],
  });

  const r = runAnalysis(base());
  const c = r.charger!;

  test("ladesalg på én linje, salg til nett separat, kostnadsøkning og netto henger sammen", () => {
    expect(c.soldKwh).toBeCloseTo(prof.kwh, 6);
    expect(c.revenueNok).toBeCloseTo(prof.kwh * 3.5, 4);
    expect(c.net).toBeCloseTo(c.revenueNok + c.exportNok - (c.costIncreaseNok + r.before.total.cost.salg) - c.opex, 3);
    // Ladingens kilder går opp i levert energi
    expect(c.sources.solarKwh + c.sources.batteryKwh + c.sources.gridKwh).toBeCloseTo(prof.kwh, 3);
    expect(c.investmentNok).toBe(1_500_000);
    expect(c.economy![0].result.rows[0].ladeinntekt).toBeCloseTo(prof.kwh * 3.5, 3);
    // Forbruket i alternativet = bygg + lading
    expect(c.result.total.loadKwh).toBeCloseTo(r.before.total.loadKwh + prof.kwh, 3);
  });

  test("ny salgspris endrer bare inntekten (samme kWh og topper)", () => {
    const r3 = runAnalysis(base(3.0)).charger!;
    expect(r3.result.total.importKwh).toBeCloseTo(c.result.total.importKwh, 6);
    expect(r3.result.total.cost.effektledd).toBeCloseTo(c.result.total.cost.effektledd, 6);
    expect(c.net - r3.net).toBeCloseTo(prof.kwh * 0.5, 3);
  });

  test("nettleie før og etter per måned for alle alternativer", () => {
    expect(r.grid.alternatives.map((a) => a.key)).toEqual(["sol", "lader"]);
    const m = r.grid.alternatives[1].months[0];
    expect(m.before.nettleie).toBeCloseTo(m.before.fastledd + m.before.energiledd + m.before.effektledd + m.before.innmating, 6);
    expect(m.before.billedKw).not.toBeNull();
    // Lading kl. 10–12 øker toppen i vinduet
    expect(m.after.billedKw!).toBeGreaterThan(m.before.billedKw! * 0.99);
  });
});
