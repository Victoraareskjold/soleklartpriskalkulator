import { describe, expect, test } from "vitest";
import { simulate, savings, valueAt } from "../engine";
import { runAnalysis, periodRange, type AnalysisInput } from "../analysis";
import { standardProfile } from "../profiles";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { HOUR, osloLocalToUtc, osloParts } from "../time";
import type { TimeSeries } from "../types";

const load = yearSeries(2024, "forbruk", (t) => (osloParts(t).hour >= 7 && osloParts(t).hour < 17 ? 120 : 40));
const spot = yearSeries(2024, "pris", (t) => 0.5 + 0.3 * Math.sin(osloParts(t).hour / 3));
const base = { load, spot, buy, sell, tariff: T, taxes };

/** Timeserie → kvarterserie (energi delt likt, eller pris gjentatt) */
function toQuarter(s: TimeSeries, energy: boolean, f?: (q: number, v: number) => number): TimeSeries {
  const v = new Float64Array(s.values.length * 4);
  for (let i = 0; i < s.values.length; i++) for (let q = 0; q < 4; q++) v[i * 4 + q] = f ? f(q, s.values[i]) : energy ? s.values[i] / 4 : s.values[i];
  return { ...s, resolutionMin: 15, values: v };
}

describe("kvartersoppløsning", () => {
  test("jevnt kvartersforbruk gir samme resultat som timer", () => {
    const h = simulate({ ...base, pv: fakePv(2024, 200) });
    const q = simulate({ ...base, load: toQuarter(load, true), pv: fakePv(2024, 200) });
    expect(q.checks.intervals).toBe(h.checks.intervals * 4);
    expect(q.total.cost.netto).toBeCloseTo(h.total.cost.netto, 4);
    expect(q.total.selfKwh).toBeCloseTo(h.total.selfKwh, 4);
  });

  test("effekt målt per time eller per kvarter: et kort kvarter-topp gir høyere kvartersgrunnlag", () => {
    // Samme energi per time, men alt i første kvarter
    const spiky = toQuarter(load, true, (q, v) => (q === 0 ? v : 0));
    const perHour = simulate({ ...base, load: spiky, pv: null });
    const perQuarter = simulate({ ...base, load: spiky, pv: null, tariff: { ...T, power: { ...T.power!, resolution: "kvarter" } } });
    const hourly = simulate({ ...base, pv: null });
    expect(perHour.total.cost.effektledd).toBeCloseTo(hourly.total.cost.effektledd, 4);
    expect(perQuarter.months[0].peakKw).toBeCloseTo(hourly.months[0].peakKw * 4, 4);
  });

  test("valueAt: time ↔ kvarter for energi og pris", () => {
    const t0 = load.startUtc;
    expect(valueAt(load, t0, 15 * 60_000, true)).toBeCloseTo(load.values[0] / 4, 9);
    expect(valueAt(spot, t0 + 15 * 60_000, 15 * 60_000, false)).toBeCloseTo(spot.values[0], 9);
    const q = toQuarter(load, true);
    expect(valueAt(q, t0, HOUR, true)).toBeCloseTo(load.values[0], 9);
  });

  test("batteri per kvarter holder energibalansen", () => {
    const r = simulate({
      ...base,
      load: toQuarter(load, true),
      spot: toQuarter(spot, false),
      pv: fakePv(2024, 200),
      battery: { usableKwh: 100, reserveShare: 0, chargeKw: 50, dischargeKw: 50, roundTrip: 0.9, auxKw: 0, gridCharge: true, gridExport: false, strategy: "smart", forecast: "persistens", wearNokPerKwh: 0 },
    });
    expect(r.checks.batteryBalanceErrorKwh!).toBeLessThan(1e-6);
    expect(r.checks.maxBalanceErrorKwh).toBeLessThan(1e-9);
    // Effekt: aldri mer enn 50 kW (12,5 kWh per kvarter)
    for (let i = 0; i < r.hourly!.battery.length; i++) expect(Math.abs(r.hourly!.battery[i])).toBeLessThanOrEqual(50 + 1e-6);
  });
});

describe("avtaler", () => {
  test("fastpris kjøp: kraftkostnad = import × fast pris", () => {
    const r = simulate({ ...base, pv: null, buy: { ...buy, type: "fastpris", fixedOrePerKwh: 80 } });
    expect(r.total.cost.kraft).toBeCloseTo(r.total.importKwh * 0.8, 3);
  });
  test("prisgulv: negative spotpriser gir ikke salgskostnad", () => {
    const neg = yearSeries(2024, "pris", () => -0.2);
    const r = simulate({ ...base, spot: neg, pv: fakePv(2024, 600), sell: { ...sell, floorOrePerKwh: 0 } });
    expect(r.total.cost.salg).toBeCloseTo(0, 6);
  });
  test("fastpris salg", () => {
    const r = simulate({ ...base, pv: fakePv(2024, 600), sell: { ...sell, type: "fastpris", fixedOrePerKwh: 50 } });
    expect(r.total.cost.salg).toBeCloseTo(r.total.exportKwh * 0.5, 3);
  });
});

describe("delt hybridinverter", () => {
  test("sol + batteriutlading overstiger aldri inverterens AC-effekt", () => {
    const pv = fakePv(2024, 300);
    const r = simulate({
      ...base, pv, inverterAcKw: 150,
      battery: { usableKwh: 300, reserveShare: 0, chargeKw: 150, dischargeKw: 150, roundTrip: 0.9, auxKw: 0, gridCharge: true, gridExport: true, strategy: "smart", forecast: "persistens", wearNokPerKwh: 0, sharedAcKw: 150 },
    });
    for (let i = 0; i < r.hourly!.battery.length; i++) {
      const b = r.hourly!.battery[i];
      if (b > 0) expect(b + r.hourly!.pv[i]).toBeLessThanOrEqual(150 + 1e-3);
    }
  });
});

describe("egendefinert periode og driftstider", () => {
  test("periode over årsskiftet: riktige grenser, 12 måneder gir levetidsøkonomi", () => {
    const p = periodRange({ kind: "egendefinert", year: 2024, from: "2024-03-14", to: "2025-03-13" });
    expect(p.years).toEqual([2024, 2025]);
    expect(p.days).toBe(365);
    expect(p.complete).toBe(true);
    expect(p.from).toBe(osloLocalToUtc(2024, 3, 14, 0)[0]);
    const kort = periodRange({ kind: "egendefinert", year: 2024, from: "2024-03-01", to: "2024-05-31" });
    expect(kort.complete).toBe(false);
  });

  test("analyse over årsskiftet med anslått profil", () => {
    const sp = { ...yearSeries(2024, "pris", () => 0.6) };
    const sp25 = yearSeries(2025, "pris", () => 0.6);
    const spotBoth: TimeSeries = { ...sp, values: Float64Array.from([...sp.values, ...sp25.values]) };
    const pv24 = fakePv(2024, 100), pv25 = fakePv(2025, 100);
    const pvBoth: TimeSeries = { ...pv24, values: Float64Array.from([...pv24.values, ...pv25.values]) };
    const inp: AnalysisInput = {
      project: { name: "T", address: "x", priceArea: "NO1", businessType: "kontor" },
      meteringPoint: { id: "m1", label: "m" },
      period: { kind: "egendefinert", year: 2024, from: "2024-07-01", to: "2025-06-30" },
      consumption: { level: 1, type: "kontor", annualKwh: 300_000 },
      production: pvBoth, spot: spotBoth, tariff: { ...T, validTo: undefined }, taxes, buy, sell, exportLimitKw: null, weatherYear: 2023,
      economy: { investmentNok: 900_000, years: 20, discountRate: 0.08, growth: { kraft: 0.02, nettleie: 0.02, avgift: 0, drift: 0.02 }, degradationPerYear: 0.004, opex: [], replacements: [] },
      scenarios: [{ name: "Hoved", kraftGrowth: 0.02 }],
    };
    const r = runAnalysis(inp);
    expect(r.period.label).toBe("1.7.2024–30.6.2025");
    expect(r.after.months.length).toBe(12);
    expect(r.economy).not.toBeNull();
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  test("måneder med redusert drift gir bare grunnlast", () => {
    const a = standardProfile({ type: "kontor", year: 2024, annualKwh: 100_000, schedule: { weekdays: [7, 17], saturday: null, sunday: null, closedMonths: [] } });
    const b = standardProfile({ type: "kontor", year: 2024, annualKwh: 100_000, schedule: { weekdays: [7, 17], saturday: null, sunday: null, closedMonths: [7] } });
    const jul = (s: TimeSeries) => {
      let sum = 0;
      for (let i = 0; i < s.values.length; i++) if (osloParts(s.startUtc + i * HOUR).month === 7) sum += s.values[i];
      return sum;
    };
    expect(jul(b)).toBeLessThan(jul(a) * 0.75);
    void savings;
  });
});
