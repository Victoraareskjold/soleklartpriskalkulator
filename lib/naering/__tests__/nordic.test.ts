import { describe, expect, test } from "vitest";
import SB from "../nordic-solergy/smart-batteri.js";
import { simulate, savings, type BatteryConfig } from "../engine";
import { tilTariff } from "../nordic";
import type { Tariff, Taxes, BuyAgreement, SellAgreement } from "../tariff";
import { fakePv, yearSeries } from "./helpers";
import { osloLocalToUtc, osloParts, HOUR } from "../time";
import type { TimeSeries } from "../types";

// Nordic Solergys smart batteri (smart-batteri.js) bygget inn i motoren. Testene viser at vi regner som dem.
// 2023 er ikke skuddår, så rutenettet deres (8760 timer uten 29. februar) dekker hele året.

const prov = { status: "antatt" as const, source: "test" };
const T0 = (o: Partial<Tariff> = {}): Tariff => ({
  id: "t", gridOwner: "t", name: "Effekttariff (test)", customerGroup: "næring", validFrom: "2023-01-01", fixedNokPerYear: 0, fixedAllocation: "per_dag",
  energyOrePerKwh: 0,
  power: { method: "maks_time_i_vindu", window: { weekdays: [1, 2, 3, 4, 5, 6, 7], fromHour: 0, toHour: 24, excludeHolidays: false }, summerMonths: [4, 5, 6, 7, 8, 9], summerNokPerKwMonth: 46, winterNokPerKwMonth: 111 },
  vat: "eks_mva", provenance: { ...prov, lastChecked: "2026-11-24" }, notes: [], ...o,
});
const noTax: Taxes = { elavgiftOrePerKwh: 0, status: "fritak", provenance: prov };
const buy: BuyAgreement = { type: "spot", markupOrePerKwh: 0, monthlyFeeNok: 0, provenance: prov };
const sell: SellAgreement = { type: "spot", deductionOrePerKwh: 0, provenance: prov };
const bat = (o: Partial<BatteryConfig> = {}): BatteryConfig => ({
  usableKwh: 200, reserveShare: 0, chargeKw: 100, dischargeKw: 100, roundTrip: 0.95 * 0.95, auxKw: 0,
  gridCharge: true, gridExport: true, strategy: "smart", forecast: "persistens", wearNokPerKwh: 0, ...o,
});

const load = yearSeries(2023, "forbruk", (t) => {
  const p = osloParts(t);
  const day = p.hour >= 7 && p.hour < 17 ? 120 : 40;
  return day + (p.day === 12 && p.hour === 9 ? 80 : 0); // én høy topp i måneden
});
const spot = yearSeries(2023, "pris", (t) => {
  const p = osloParts(t);
  const h = p.hour;
  const base = h < 6 ? 0.3 : h >= 7 && h < 10 ? 1.3 : h >= 17 && h < 21 ? 1.5 : 0.7;
  return base * (1 + 0.3 * Math.sin(p.day)); // litt variasjon mellom dagene
});
const pv = fakePv(2023, 250);

/** Serie i Nordic Solergys rutenett: første time på hver lokale dato og klokketime, manglende vårtime = timen før. */
function rutenett(s: TimeSeries): Float64Array {
  const out = new Float64Array(8760).fill(NaN);
  for (let i = 0; i < s.values.length; i++) {
    const p = osloParts(s.startUtc + i * HOUR);
    const k = (SB.DAG_FOR_MND[p.month - 1] + p.day - 1) * 24 + p.hour;
    if (Number.isNaN(out[k])) out[k] = s.values[i];
  }
  for (let k = 0; k < 8760; k++) if (Number.isNaN(out[k])) out[k] = out[k - 1];
  return out;
}

describe("Nordic Solergys smart batteri i motoren", () => {
  const common = { load, spot, buy, sell, tariff: T0(), taxes: noTax };
  const sol = simulate({ ...common, pv });
  const smart = simulate({ ...common, pv, battery: bat() });

  test("motoren følger planen time for time når ingen grenser binder", () => {
    expect(smart.checks.smartPlanDeviationKwh).toBeLessThan(1e-6);
    expect(smart.checks.batteryBalanceErrorKwh).toBeLessThan(1e-6);
  });

  test("batteriets gevinst er den samme som i Nordic Solergys egen beregning (simuler)", () => {
    const forbruk = rutenett(load), solR = rutenett(pv), spotR = rutenett(spot);
    const tariff = { type: "effekt" as const, effektVinter: 111, effektSommer: 46, fastledd: 0 };
    const S = SB.INNSTILLINGER, saved = { ...S };
    let deres: number;
    try {
      S.startNivaa = 0; // som hos oss: batteriet starter tomt (reservenivået)
      const r = (kap: number) => SB.simuler({ forbruk, sol: solR, kjop: spotR, salg: spotR, kapKwh: kap, kw: 100, smart: true, tariff, mvaF: 1 });
      deres = r(200).okonomi.gevinst - r(0).okonomi.gevinst;
    } finally {
      Object.assign(S, saved);
    }
    const vaar = savings(sol, smart).total;
    expect(deres).toBeGreaterThan(10_000);
    // Forskjellen er sommertidstimene (rutenettet deres har én time mindre om våren og én mer om høsten)
    expect(Math.abs(vaar - deres) / deres).toBeLessThan(0.005);
  });

  test("perfekt prognose er den samme beregningen", () => {
    const p = simulate({ ...common, pv, battery: bat({ forecast: "perfekt" }) });
    expect(p.total.cost.netto).toBeCloseTo(smart.total.cost.netto, 6);
  });

  test("startnivå og sluttnivå: ingen gratis energi", () => {
    expect(smart.checks.startSocKwh).toBe(0);
    expect(Math.abs((smart.checks.endSocKwh ?? 0) - (smart.checks.startSocKwh ?? 0))).toBeLessThan(5);
  });
});

describe("sjekklisten i beskrivelsen (punkt 10)", () => {
  const flat = yearSeries(2023, "pris", () => 0.8);
  const ingenEffekt = T0({ power: undefined });

  test("flat pris, ingen effekttariff, ingen sol: gevinsten er nesten 0", () => {
    const c = { load, spot: flat, buy, sell, tariff: ingenEffekt, taxes: noTax };
    const g = savings(simulate(c), simulate({ ...c, battery: bat() })).total;
    expect(Math.abs(g)).toBeLessThan(100);
  });

  test("prisforskjell under 15 % + tap: batteriet handler ikke", () => {
    const to = yearSeries(2023, "pris", (t) => (osloParts(t).hour < 6 ? 0.8 : 0.9));
    const c = { load, spot: to, buy, sell, tariff: ingenEffekt, taxes: noTax };
    const r = simulate({ ...c, battery: bat() });
    expect(r.total.battery!.gridChargeKwh).toBeLessThan(1);
  });

  test("én høy topp i måneden og høy effektsats: toppen kappes med opptil batteriets kW", () => {
    const hoy = T0({ power: { ...T0().power!, summerNokPerKwMonth: 300, winterNokPerKwMonth: 300 } });
    const c = { load, spot: flat, buy, sell, tariff: hoy, taxes: noTax };
    const before = simulate(c), after = simulate({ ...c, battery: bat() });
    for (let m = 0; m < 12; m++) {
      expect(before.months[m].peakKw).toBeCloseTo(200, 6);
      expect(after.months[m].peakKw).toBeLessThan(before.months[m].peakKw - 70);
      expect(after.months[m].peakKw).toBeGreaterThanOrEqual(before.months[m].peakKw - 100 - 1e-6);
    }
  });

  test("soloverskudd midt på dagen og høy kveldspris: overskuddet lagres og brukes om kvelden", () => {
    const kveld = yearSeries(2023, "pris", (t) => (osloParts(t).hour >= 18 && osloParts(t).hour < 22 ? 2 : 0.5));
    const lite = yearSeries(2023, "forbruk", () => 20);
    const c = { load: lite, spot: kveld, buy, sell, tariff: ingenEffekt, taxes: noTax, pv: fakePv(2023, 300) };
    const r = simulate({ ...c, battery: bat({ gridCharge: false }) });
    const b = r.total.battery!;
    expect(b.solarChargeKwh).toBeGreaterThan(10_000);
    expect(b.gridChargeKwh).toBeLessThan(1);
    expect(savings(simulate(c), r).total).toBeGreaterThan(5_000);
  });
});

describe("tilpasningen", () => {
  test("kvarter gir samme resultat som timer når forbruket er jevnt i timen", () => {
    const q = (s: TimeSeries): TimeSeries => {
      const v = new Float64Array(s.values.length * 4);
      for (let i = 0; i < v.length; i++) v[i] = s.kind === "pris" ? s.values[i >> 2] : s.values[i >> 2] / 4;
      return { ...s, resolutionMin: 15, values: v };
    };
    const c = { spot, buy, sell, tariff: T0(), taxes: noTax };
    const h = simulate({ ...c, load, pv, battery: bat() });
    const k = simulate({ ...c, load: q(load), pv: q(pv), battery: bat() });
    expect(Math.abs(k.total.cost.netto - h.total.cost.netto) / h.total.cost.netto).toBeLessThan(0.001);
  });

  test("delperiode: batteriet starter på reservenivået og står stille utenfor perioden", () => {
    const from = osloLocalToUtc(2023, 3, 1, 0)[0];
    const to = osloLocalToUtc(2023, 9, 1, 0)[0];
    const c = { load, spot, buy, sell, tariff: T0(), taxes: noTax, pv, fromUtc: from, toUtc: to };
    const r = simulate({ ...c, battery: bat({ reserveShare: 0.1 }) });
    expect(r.checks.startSocKwh).toBeCloseTo(20, 6);
    expect(r.months.map((m) => m.month)).toEqual(["2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08"]);
    expect(savings(simulate(c), r).total).toBeGreaterThan(0);
    expect(r.tariffNotes.notes.some((n) => n.startsWith("Delperiode"))).toBe(true);
  });

  test("flere enn to effektsatser i året: riktig sats per måned", () => {
    const rate = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const { tariff } = tilTariff(rate.map((r) => ({ model: "sats", nokPerKw: r })), new Array(12).fill(0), 50);
    const timer = new Float64Array(720).fill(1);
    for (let m = 0; m < 12; m++) expect(SB.effektMnd(timer, m, tariff!, 1).kr).toBeCloseTo(rate[m], 9);
  });

  test("to satser: vanlig sommer/vinter-tariff", () => {
    const { tariff } = tilTariff([111, 111, 111, 46, 46, 46, 46, 46, 46, 111, 111, 111].map((r) => ({ model: "sats", nokPerKw: r })), new Array(12).fill(0), 50);
    expect(tariff).toMatchObject({ type: "effekt", effektVinter: 111, effektSommer: 46, vinterMnd: [0, 1, 2, 9, 10, 11] });
  });

  test("kapasitetstrinn målt som snitt av tre døgntopper blir trinn hos Nordic Solergy", () => {
    const trinn = [{ til_kw: 5, kr_per_mnd: 100 }, { til_kw: 10, kr_per_mnd: 300 }, { til_kw: null, kr_per_mnd: 900 }];
    const { tariff } = tilTariff(new Array(12).fill({ model: "trinn", trinn, grenser: "nedre_inklusiv", treDoegn: true }), new Array(12).fill(0), 10);
    expect(tariff).toEqual({ type: "trinn", trinn: [[0, 5, 100], [5, 10, 300], [10, null, 900]] });
  });
});
