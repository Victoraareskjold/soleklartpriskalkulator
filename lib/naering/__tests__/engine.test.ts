import { describe, expect, test } from "vitest";
import { simulate, savings } from "../engine";
import { lifetime } from "../economy";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { osloParts } from "../time";

const load = yearSeries(2024, "forbruk", (t) => (osloParts(t).hour >= 7 && osloParts(t).hour < 17 ? 120 : 40));
const spot = yearSeries(2024, "pris", (t) => 0.5 + 0.3 * Math.sin(osloParts(t).hour / 3));
const base = { load, spot, buy, sell, tariff: T, taxes };

describe("motor", () => {
  test("ingen solceller gir ingen gevinst", () => {
    const a = simulate({ ...base, pv: null });
    const b = simulate({ ...base, pv: yearSeries(2024, "produksjon", () => 0) });
    expect(savings(a, b).total).toBeCloseTo(0, 9);
  });

  test("energibalansen stemmer per time og for året", () => {
    const r = simulate({ ...base, pv: fakePv(2024, 300) });
    expect(r.checks.maxBalanceErrorKwh).toBeLessThan(1e-9);
    const t = r.total;
    expect(t.selfKwh + t.importKwh).toBeCloseTo(t.loadKwh, 6);
    expect(t.selfKwh + t.exportKwh + t.curtailedKwh).toBeCloseTo(t.pvKwh, 6);
    expect(r.checks.intervals).toBe(8784);
  });

  test("faste ledd og gebyrer regnes ikke som spart", () => {
    const s = savings(simulate({ ...base, pv: null }), simulate({ ...base, pv: fakePv(2024, 300) }));
    expect(s.fastOgGebyr).toBeCloseTo(0, 9);
  });

  test("eksportgrense avkorter overskudd", () => {
    const r = simulate({ ...base, pv: fakePv(2024, 600), exportLimitKw: 50 });
    expect(r.total.curtailedKwh).toBeGreaterThan(0);
    for (const m of r.months) expect(m.exportKwh).toBeLessThanOrEqual(50 * m.days * 24 + 1e-6);
  });

  test("negativ spotpris gjør eksport til en kostnad", () => {
    const neg = yearSeries(2024, "pris", () => -0.1);
    const r = simulate({ ...base, spot: neg, pv: fakePv(2024, 600) });
    expect(r.total.cost.salg).toBeLessThan(0);
  });

  test("manglende forbruk stopper beregningen – aldri stille null", () => {
    const hole = { ...load, values: Float64Array.from(load.values) };
    hole.values[100] = NaN;
    expect(() => simulate({ ...base, load: hole, pv: null })).toThrow(/mangler/);
  });

  test("satsendring midt i året brukes fra riktig måned", () => {
    const r = simulate({ ...base, pv: null });
    const jun = r.months[5], jul = r.months[6];
    expect(jun.cost.effektledd / jun.peakKw).toBeCloseTo(31, 9);
    expect(jul.cost.effektledd / jul.peakKw).toBeCloseTo(35, 9);
    expect(r.months[0].cost.effektledd / r.months[0].peakKw).toBeCloseTo(68, 9);
    expect(r.months[11].cost.effektledd / r.months[11].peakKw).toBeCloseTo(77, 9);
  });
});

describe("økonomi", () => {
  const eco = {
    investmentNok: 1_000_000,
    years: 30,
    discountRate: 0.0812,
    growth: { kraft: 0.035, nettleie: 0.02, avgift: 0, drift: 0.02 },
    degradationPerYear: 0.004,
    opex: [{ name: "Service", nokPerYear: 2500 }],
    replacements: [{ name: "Inverterbytte", year: 15, nok: 160_000 }],
  };
  const io = { before: { ...base, pv: null }, after: { ...base, pv: fakePv(2024, 300) } };

  test("nåverdi = nåverdi av drift − investering, og avstemmer mot radene", () => {
    const r = lifetime(io, eco);
    expect(r.npv!).toBeCloseTo(r.pvOfOperations - 1_000_000, 6);
    expect(r.rows.reduce((a, x) => a + x.diskontert, 0)).toBeCloseTo(r.pvOfOperations, 6);
    expect(r.rows[14].utskifting).toBe(160_000);
    expect(r.rows[29].pvKwh).toBeLessThan(r.rows[0].pvKwh); // degradering påvirker energien
  });

  test("uavklart investering gir ingen nåverdi eller tilbakebetaling", () => {
    const r = lifetime(io, { ...eco, investmentNok: null });
    expect(r.npv).toBeNull();
    expect(r.paybackYears).toBeNull();
    expect(r.pvOfOperations).toBeGreaterThan(0);
  });

  test("internrente gir nåverdi 0", () => {
    const r = lifetime(io, { ...eco, replacements: [] });
    const flows = [-1_000_000, ...r.rows.map((x) => x.netto)];
    const npv = flows.reduce((a, v, i) => a + v / Math.pow(1 + r.irr!, i), 0);
    expect(Math.abs(npv)).toBeLessThan(1);
  });

  test("prosjekt som ikke betaler seg tilbake sier det", () => {
    const r = lifetime(io, { ...eco, investmentNok: 1e9 });
    expect(r.paybackYears).toBeNull();
    expect(r.npv!).toBeLessThan(0);
  });
});

describe("runde A: avgiftsperioder, inverterkapping, historisk netto", () => {
  test("elavgift følger periodene i året (2025: 9,79 / 16,93 / 12,53)", async () => {
    const { taxPeriods } = await import("../taxes");
    const tp = taxPeriods("ordinær", "2025-01-01", "2025-12-31");
    expect(tp.missing).toBeNull();
    const l25 = yearSeries(2025, "forbruk", () => 10);
    const sp25 = yearSeries(2025, "pris", () => 0.5);
    const r = simulate({ ...base, load: l25, spot: sp25, pv: null, taxes: { ...taxes, elavgiftOrePerKwh: 0, periods: tp.periods } });
    expect(r.months[0].cost.elavgift / r.months[0].importKwh).toBeCloseTo(0.0979, 6);
    expect(r.months[5].cost.elavgift / r.months[5].importKwh).toBeCloseTo(0.1693, 6);
    expect(r.months[10].cost.elavgift / r.months[10].importKwh).toBeCloseTo(0.1253, 6);
  });

  test("manglende sats gir avvik, ikke stille null", async () => {
    const { taxPeriods } = await import("../taxes");
    expect(taxPeriods("redusert", "2025-01-01", "2025-12-31").missing).toBe("2025-01-01");
  });

  test("inverterens AC-effekt kapper produksjonen, og energien balanserer", () => {
    const pv = yearSeries(2024, "produksjon", (t) => (osloParts(t).hour === 12 ? 100 : 0));
    const r = simulate({ ...base, pv, inverterAcKw: 60 });
    expect(r.total.clippedKwh).toBeCloseTo(40 * 366, 6);
    expect(r.total.pvKwh).toBeCloseTo(60 * 366, 6);
    expect(r.total.selfKwh + r.total.exportKwh + r.total.curtailedKwh).toBeCloseTo(r.total.pvKwh, 6);
  });
});
