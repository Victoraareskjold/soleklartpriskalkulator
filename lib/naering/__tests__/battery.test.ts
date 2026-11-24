import { describe, expect, test } from "vitest";
import { simulate, savings, hourFlow, type BatteryConfig } from "../engine";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { osloParts } from "../time";

const load = yearSeries(2024, "forbruk", (t) => (osloParts(t).hour >= 7 && osloParts(t).hour < 17 ? 120 : 40));
// Billig natt, dyr morgen og kveld
const spot = yearSeries(2024, "pris", (t) => {
  const h = osloParts(t).hour;
  return h < 6 ? 0.2 : h >= 7 && h < 10 ? 1.4 : h >= 17 && h < 21 ? 1.6 : 0.6;
});
const flat = yearSeries(2024, "pris", () => 0.8);
const base = { load, spot, buy, sell, tariff: T, taxes };
const pv = fakePv(2024, 300);

const bat = (o: Partial<BatteryConfig> = {}): BatteryConfig => ({
  usableKwh: 200, reserveShare: 0, chargeKw: 100, dischargeKw: 100, roundTrip: 0.9, auxKw: 0,
  gridCharge: true, gridExport: false, strategy: "smart", forecast: "persistens", wearNokPerKwh: 0, ...o,
});

describe("timefordeling", () => {
  test("lading fra sol før nett, utlading til bygg før nett, eksportgrense kapper sol først", () => {
    const f = hourFlow(50, 120, -100, Infinity, false);
    expect(f.pvToBatt).toBeCloseTo(70);
    expect(f.gridToBatt).toBeCloseTo(30);
    expect(f.imp).toBeCloseTo(30);
    const g = hourFlow(50, 120, 40, 60, false);
    expect(g.battToGrid).toBeCloseTo(40);
    expect(g.pvExport).toBeCloseTo(20); // 60 − 40 fra batteriet
    expect(g.curtailed).toBeCloseTo(50);
  });
});

describe("batteri", () => {
  test("energibalanse, ladetilstand og like start/slutt holder hele året", () => {
    for (const strategy of ["grunn", "smart"] as const) {
      const r = simulate({ ...base, pv, battery: bat({ strategy }) });
      expect(r.checks.maxBalanceErrorKwh).toBeLessThan(1e-9);
      expect(r.checks.batteryBalanceErrorKwh!).toBeLessThan(1e-6);
      const b = r.total.battery!;
      // Tapet er inn − ut − endring i lager, og aldri negativt
      expect(b.lossKwh).toBeGreaterThan(-1e-6);
      expect(b.chargeKwh - b.dischargeKwh - b.lossKwh).toBeCloseTo(r.checks.endSocKwh! - r.checks.startSocKwh!, 4);
      for (let i = 0; i < r.hourly!.soc.length; i++) {
        expect(r.hourly!.soc[i]).toBeLessThanOrEqual(200 + 1e-3);
        expect(r.hourly!.soc[i]).toBeGreaterThanOrEqual(-1e-3);
      }
    }
  });

  test("grunnstyring øker egenbruk og lader aldri fra nettet", () => {
    const pvOnly = simulate({ ...base, pv });
    const g = simulate({ ...base, pv, battery: bat({ strategy: "grunn" }) });
    expect(g.total.selfKwh).toBeGreaterThan(pvOnly.total.selfKwh);
    expect(g.total.battery!.gridChargeKwh).toBe(0);
    expect(g.total.battery!.toGridKwh).toBe(0);
    // Nettstrøm via batteriet regnes ikke som egenbruk av sol
    expect(g.total.selfKwh).toBeLessThanOrEqual(g.total.pvKwh + 1e-6);
  });

  test("smartstyring tjener på prisforskjeller og er minst like god som grunnstyring", () => {
    const pvOnly = simulate({ ...base, pv });
    const g = simulate({ ...base, pv, battery: bat({ strategy: "grunn" }) });
    const s = simulate({ ...base, pv, battery: bat({ strategy: "smart" }) });
    expect(s.total.battery!.gridChargeKwh).toBeGreaterThan(0);
    expect(s.total.cost.netto).toBeLessThan(g.total.cost.netto);
    expect(g.total.cost.netto).toBeLessThan(pvOnly.total.cost.netto);
  });

  test("perfekt prognose og persistens gir samme resultat (Nordic Solergys styring kjenner forbruk og sol)", () => {
    const s = simulate({ ...base, pv, battery: bat({ strategy: "smart", forecast: "persistens" }) });
    const p = simulate({ ...base, pv, battery: bat({ strategy: "smart", forecast: "perfekt" }) });
    expect(p.total.cost.netto).toBeCloseTo(s.total.cost.netto, 6);
  });

  test("flate priser: ulønnsom handel unngås (ingen nettlading for å selge eller lagre)", () => {
    const s = simulate({ ...base, spot: flat, pv: null, tariff: { ...T, power: undefined }, battery: bat({ strategy: "smart", gridExport: true }) });
    expect(s.total.battery!.gridChargeKwh).toBeLessThan(1);
    expect(s.total.battery!.toGridKwh).toBeLessThan(1);
  });

  test("dårligere tap og mindre kapasitet gir mindre gevinst", () => {
    const before = simulate({ ...base, pv: null });
    const gain = (o: Partial<BatteryConfig>) => savings(before, simulate({ ...base, pv: null, battery: bat(o) })).total;
    const good = gain({});
    expect(gain({ roundTrip: 0.7 })).toBeLessThan(good);
    expect(gain({ usableKwh: 40 })).toBeLessThan(good);
    expect(good).toBeGreaterThan(0);
  });

  test("eksportgrense begrenser salg fra både sol og batteri", () => {
    const r = simulate({ ...base, pv: fakePv(2024, 600), exportLimitKw: 30, battery: bat({ gridExport: true }) });
    for (let i = 0; i < r.hourly!.battery.length; i++) {
      const L = r.hourly!.load[i], P = r.hourly!.pv[i], b = r.hourly!.battery[i];
      const f = hourFlow(L, P, b, 30, false);
      expect(f.exp).toBeLessThanOrEqual(30 + 1e-6);
    }
    for (const m of r.months) expect(m.exportKwh).toBeLessThanOrEqual(30 * m.days * 24 + 1e-6);
  });

  test("nettlading teller i effekttoppen og elavgiften", () => {
    const none = simulate({ ...base, pv: null });
    const s = simulate({ ...base, pv: null, battery: bat({ strategy: "smart" }) });
    // Elavgift betales også av ladestrømmen: mer import gir mer elavgift totalt
    expect(s.total.importKwh).toBeGreaterThan(none.total.importKwh);
    expect(s.total.cost.elavgift).toBeGreaterThan(none.total.cost.elavgift);
    // Nordic Solergys styring kapper toppene bare når det lønner seg mer enn prishandel (beskrivelsen punkt 4.5):
    // her er prisforskjellen stor og effektsatsen lav, så effektleddet kan øke – men regningen blir lavere.
    expect(s.total.cost.netto).toBeLessThan(none.total.cost.netto);
  });

  test("hjelpelast og nødstrømsreserve reduserer gevinsten", () => {
    const before = simulate({ ...base, pv: null });
    const gain = (o: Partial<BatteryConfig>) => savings(before, simulate({ ...base, pv: null, battery: bat(o) })).total;
    expect(gain({ auxKw: 1 })).toBeLessThan(gain({}));
    expect(gain({ reserveShare: 0.5 })).toBeLessThan(gain({}));
  });
});
