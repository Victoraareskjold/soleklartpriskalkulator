import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseV53, parseV6, alignToYear, pvgisUrl } from "../pvgis";
import { buildPriceSeries } from "../prices";
import { standardProfile } from "../profiles";
import { runAnalysis } from "../analysis";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { osloParts } from "../time";

describe("PVGIS", () => {
  test("v5.3: W per time blir kWh, UTC-tid, 29. feb hentes fra 28. feb", () => {
    const hourly = [];
    for (let d = 0; d < 365; d++)
      for (let h = 0; h < 24; h++) {
        const dt = new Date(Date.UTC(2023, 0, 1 + d, h, 10));
        const s = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}:${String(h).padStart(2, "0")}10`;
        hourly.push({ time: s, P: h === 11 ? 50_000 : 0 }); // 50 kW kl. 11 UTC = 12 lokal vintertid
      }
    const p = parseV53({ outputs: { hourly } });
    expect(p.kwh.reduce((a, b) => a + b, 0)).toBeCloseTo(365 * 50, 6);
    const a = alignToYear(p, 2023, 2024);
    expect(a.kwh.length).toBe(8784);
    expect(a.kwh.reduce((x, y) => x + y, 0)).toBeCloseTo(366 * 50, 6); // ekstra dag fra 28. feb
    expect(a.notes.join(" ")).toMatch(/tilpasset/);
  });

  test("retning: sør = asimut 180 → v5 aspect 0, v6 orientation 180", () => {
    const s = { id: "a", kwp: 198, tiltDeg: 15, azimuthDeg: 180, lossPct: 14, meteringPointId: "m" };
    expect(pvgisUrl("v5_3", 62.47, 6.15, s, 2023)).toContain("aspect=0");
    expect(pvgisUrl("v6", 62.47, 6.15, s, 2024)).toContain("surface_orientation=180");
    expect(pvgisUrl("v6", 62.47, 6.15, s, 2024)).toContain("/api/v6/power/broadband?");
  });

  // Ekte svar fra /api/v6/power/broadband, 60.88 N 12.01 Ø, 1 kWp, 15° sør, hele 2025 i UTC (hentet 29.10.2026)
  const v6 = JSON.parse(readFileSync(join(__dirname, "fixtures/pvgis6-power-2025.json"), "utf8"));
  test("v6: ekte årssvar – 8760 timer, Wh → kWh, 8 manglende timer fylles", () => {
    const p = parseV6(v6, Date.UTC(2025, 0, 1), 8760);
    const sum = p.kwh.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(860);
    expect(sum).toBeLessThan(862); // 860,5 kWh/kWp + fylte timer
    expect(p.kwh.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(p.notes.join(" ")).toMatch(/8 time\(r\) manglet/);
    // Natt i januar er 0, middag i juni er størst
    expect(p.kwh[0]).toBe(0);
  });

  test("v6: feil lengde eller summesvar fra /performance stopper", () => {
    expect(() => parseV6(v6, Date.UTC(2025, 0, 1), 8784)).toThrow(/forventet 8784/);
    expect(() => parseV6({ photovoltaic_performance: { energy: { value: 33.7 } } }, 0)).toThrow(/power/);
    expect(() => parseV6({ power: Array(100).fill(null) }, 0)).toThrow(/mangler/);
  });
});

describe("spotpriser", () => {
  test("kvarterspriser blir timesnitt, hull blir NaN", () => {
    const rows = [0, 15, 30, 45].map((m, i) => ({
      NOK_per_kWh: i + 1, EUR_per_kWh: 0, EXR: 11,
      time_start: `2025-10-02T00:${String(m).padStart(2, "0")}:00+02:00`,
      time_end: `2025-10-02T00:${String(m + 15).padStart(2, "0")}:00+02:00`.replace("00:60", "01:00"),
    }));
    rows.push({ NOK_per_kWh: 9, EUR_per_kWh: 0, EXR: 11, time_start: "2025-10-02T02:00:00+02:00", time_end: "2025-10-02T03:00:00+02:00" });
    const { series, notes } = buildPriceSeries(rows, "NO3");
    expect(series.values[0]).toBeCloseTo(2.5, 9);
    expect(Number.isNaN(series.values[1])).toBe(true);
    expect(notes.join(" ")).toMatch(/kvarter/);
  });
});

describe("standardprofil", () => {
  test("summerer til årsforbruket og har lavere last i helg", () => {
    const p = standardProfile({ type: "kontor", year: 2025, annualKwh: 200_000 });
    expect(p.values.reduce((a, b) => a + b, 0)).toBeCloseTo(200_000, 3);
    expect(p.provenance.status).toBe("antatt");
    const at = (wd: number) => {
      let s = 0;
      for (let i = 0; i < p.values.length; i++) {
        const lp = osloParts(p.startUtc + i * 3_600_000);
        if (lp.weekday === wd && lp.hour === 12 && lp.month === 3) s += p.values[i];
      }
      return s;
    };
    expect(at(6)).toBeLessThan(at(3));
  });
  test("månedsforbruk (nivå 2) treffer hver måned", () => {
    const m = [20, 18, 17, 15, 12, 10, 8, 9, 12, 15, 18, 21].map((x) => x * 1000);
    const p = standardProfile({ type: "lager", year: 2024, annualKwh: 0, monthlyKwh: m });
    expect(p.values.reduce((a, b) => a + b, 0)).toBeCloseTo(m.reduce((a, b) => a + b, 0), 3);
  });
});

describe("analyse", () => {
  const input = () => ({
    project: { name: "Test", address: "Testveien 1", priceArea: "NO3", businessType: "kontor" as const },
    meteringPoint: { id: "m1", label: "Hovedmåler" },
    period: { kind: "år" as const, year: 2024 },
    consumption: { level: 1 as const, type: "kontor" as const, annualKwh: 400_000 },
    production: fakePv(2024, 198),
    spot: yearSeries(2024, "pris", () => 0.6),
    tariff: T, taxes, buy, sell, exportLimitKw: null,
    economy: {
      investmentNok: null, years: 30, discountRate: 0.0812,
      growth: { kraft: 0.035, nettleie: 0.02, avgift: 0, drift: 0.02 },
      degradationPerYear: 0.004, opex: [{ name: "Service", nokPerYear: 2500 }], replacements: [],
    },
    scenarios: [{ name: "Hoved", kraftGrowth: 0.035 }, { name: "Ingen prisvekst", kraftGrowth: 0 }],
  });

  test("samme grunnlag gir samme hash (låsbart), endret grunnlag gir ny hash", () => {
    const a = runAnalysis(input());
    const b = runAnalysis(input());
    expect(a.inputHash).toBe(b.inputHash);
    const c = runAnalysis({ ...input(), consumption: { level: 1, type: "kontor", annualKwh: 400_001 } });
    expect(c.inputHash).not.toBe(a.inputHash);
    expect(a.checks.every((x) => x.ok)).toBe(true);
  });

  test("hittil i år: ingen levetidsøkonomi, tydelig delår", () => {
    const r = runAnalysis({ ...input(), period: { kind: "hittil", year: 2024, toMonth: 6, toDay: 30 } });
    expect(r.economy).toBeNull();
    expect(r.period.complete).toBe(false);
    expect(r.customerSentence).toMatch(/ikke et helt årsresultat/);
  });
});

describe("runde A: analyse", () => {
  const base = () => ({
    project: { name: "T", address: "x", priceArea: "NO1", businessType: "kontor" as const },
    meteringPoint: { id: "m1", label: "m" },
    period: { kind: "år" as const, year: 2024 },
    consumption: { level: 1 as const, type: "kontor" as const, annualKwh: 400_000 },
    production: fakePv(2024, 100),
    spot: yearSeries(2024, "pris", () => 0.6),
    tariff: T, taxes, buy, sell, exportLimitKw: null,
    weatherYear: 2023,
    economy: { investmentNok: 1_000_000, years: 30, discountRate: 0.0812, growth: { kraft: 0.035, nettleie: 0.02, avgift: 0, drift: 0.02 }, degradationPerYear: 0.004, opex: [{ name: "Service", nokPerYear: 5000 }], replacements: [] },
    scenarios: [{ name: "Hoved", kraftGrowth: 0.035 }],
  });

  test("netto gevinst = lavere energikostnad − løpende kostnader, og = første år i kontantstrømmen", () => {
    const r = runAnalysis(base());
    expect(r.historical.net).toBeCloseTo(r.savings.total - 5000, 6);
    expect(r.economy![0].result.firstYearNet).toBeCloseTo(r.historical.net, 6);
  });

  test("prisår og værår vises, og feil-avvik gjør resultatet ugyldig", () => {
    const r = runAnalysis({ ...base(), issues: [{ level: "feil", field: "tariff", message: "x" }] });
    expect(r.years).toEqual({ price: 2024, weather: 2023 });
    expect(r.issues.some((i) => /værgrunnlag 2023/.test(i.message))).toBe(true);
    expect(r.valid).toBe(false);
  });

  test("tariff-scenario står i kundeteksten", () => {
    const r = runAnalysis({ ...base(), tariffScenario: true });
    expect(r.customerSentence).toMatch(/annen periode/);
    expect(r.basis.find((b) => b.what === "Spotpris")?.sourceType).toBe("markedspriser");
    expect(r.basis.find((b) => b.what === "Nettleie")?.confirmed).toBe(false);
  });
});
