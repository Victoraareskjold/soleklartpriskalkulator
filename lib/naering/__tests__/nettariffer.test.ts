// Kontrolleksemplene fra Asbjørn (Nettariffer/kontrolleksempler.json, 8.11.2026) mot motoren.
// Fiktive kontrolltall, eks. mva. Hver test regner bare de fakturalinjene eksemplet oppgir.
import { describe, expect, test } from "vitest";
import pkgJson from "../data/nettariffer-2026-11-08.json";
import { simulate } from "../engine";
import { gridDefinitions, gridTariff, type TariffPackage } from "../nettariffRegistry";
import { capacityStep, suggestTariff, versionAt, type GridTariffDefinition } from "../gridtariff";
import type { BuyAgreement, SellAgreement, Taxes } from "../tariff";
import type { TimeSeries } from "../types";
import { HOUR, MIN, osloLocalToUtc, osloParts } from "../time";

const pkg = pkgJson as unknown as TariffPackage;
const defs = gridDefinitions(pkg);
const def = (product: string, area = "hele_nettomraadet"): GridTariffDefinition => {
  const d = defs.find((x) => x.product.id === product && x.area === area);
  if (!d) throw new Error(`mangler ${product} ${area}`);
  return d;
};

const buy: BuyAgreement = { type: "spot", markupOrePerKwh: 0, monthlyFeeNok: 0, provenance: { status: "antatt", source: "test" } };
const sell: SellAgreement = { type: "spot", deductionOrePerKwh: 0, provenance: { status: "antatt", source: "test" } };
const noTax: Taxes = { elavgiftOrePerKwh: 0, status: "fritak", provenance: { status: "antatt", source: "test" } };
const ordinaryTax: Taxes = { elavgiftOrePerKwh: 7.13, status: "ordinær", provenance: { status: "antatt", source: "test" } };

/** Timeserie for én lokal måned i 2026. f får lokal dato/time. */
function month(year: number, mon: number, f: (p: { day: number; hour: number; i: number }) => number, kind: TimeSeries["kind"] = "forbruk", stepMin: 15 | 60 = 60): TimeSeries {
  const start = osloLocalToUtc(year, mon, 1, 0)[0];
  const end = mon === 12 ? osloLocalToUtc(year + 1, 1, 1, 0)[0] : osloLocalToUtc(year, mon + 1, 1, 0)[0];
  const step = stepMin * MIN;
  const n = Math.round((end - start) / step);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = osloParts(start + i * step);
    v[i] = f({ day: p.day, hour: p.hour, i });
  }
  return { kind, startUtc: start, resolutionMin: stepMin, values: v, unit: kind === "pris" ? "NOK/kWh" : "kWh", provenance: { status: "antatt", source: "test" } };
}

const zeroSpot = (y: number, m: number) => month(y, m, () => 0, "pris");

function run(product: string, area: string, load: TimeSeries, taxes = noTax, extra: { contractedKw?: number } = {}) {
  const p = osloParts(load.startUtc);
  return simulate({ load, spot: zeroSpot(p.year, p.month), buy, sell, tariff: gridTariff(def(product, area), extra), taxes });
}

/** Last med bestemte timetopper (kW) på bestemte dager, ellers lav last. */
const peaks = (y: number, m: number, byDay: number[][], rest: number) =>
  month(y, m, ({ day, hour }) => {
    const d = byDay[day - 1];
    return d && hour < d.length ? d[hour] : rest;
  });

describe("kontrolleksempler nettariffer", () => {
  test("1 EL.K: tre topper fra ulike dager, ett beløp for trinnet", () => {
    const before = run("EL.K", "hele_nettomraadet", peaks(2026, 7, [[28, 27.5, 27], [27], [26]], 10));
    const after = run("EL.K", "hele_nettomraadet", peaks(2026, 7, [[14, 13.5, 13], [13], [12]], 10));
    const b = before.months[0], a = after.months[0];
    expect(b.grid!.billedKw).toBeCloseTo(27, 6);
    expect(a.grid!.billedKw).toBeCloseTo(13, 6);
    expect(b.cost.effektledd).toBeCloseTo(1474.67, 2);
    expect(a.cost.effektledd).toBeCloseTo(534.67, 2);
    expect(b.cost.effektledd - a.cost.effektledd).toBeCloseTo(940, 2);
  });

  test("2 GL.L (Glitre): hver kW koster penger, også over 100 kW", () => {
    const area = "glitre_tidligere_agder_buskerud_hadeland";
    const before = run("GL.L", area, peaks(2026, 10, [[400]], 50)).months[0];
    const after = run("GL.L", area, peaks(2026, 10, [[200]], 50)).months[0];
    expect(before.cost.effektledd).toBeCloseTo(40800, 2);
    expect(after.cost.effektledd).toBeCloseTo(20400, 2);
    expect(before.cost.fastledd - after.cost.fastledd).toBeCloseTo(0, 6);
  });

  test("3 GL.L (tidligere Norgesnett): to marginale blokker, snitt av tre døgnmakser", () => {
    const area = "tidligere_norgesnett_fredrikstad_mfl";
    const before = run("GL.L", area, peaks(2026, 1, [[400], [400], [400]], 50)).months[0];
    const after = run("GL.L", area, peaks(2026, 1, [[200], [200], [200]], 50)).months[0];
    expect(before.cost.effektledd).toBeCloseTo(26159, 2);
    expect(after.cost.effektledd).toBeCloseTo(13175, 2);
    expect(before.cost.effektledd - after.cost.effektledd).toBeCloseTo(12984, 2);
  });

  test("4 LD.L: hel nettleiefaktura før og etter (juli)", () => {
    const hours = 31 * 24;
    const load = (kwh: number, maxKw: number) => month(2026, 7, ({ i }) => (i === 100 ? maxKw : (kwh - maxKw) / (hours - 1)));
    const b = run("LD.L", "hele_nettomraadet", load(16000, 200), ordinaryTax).months[0].cost;
    const a = run("LD.L", "hele_nettomraadet", load(13000, 150), ordinaryTax).months[0].cost;
    const bill = (c: typeof b) => c.fastledd + c.energiledd + c.effektledd + c.elavgift;
    expect(bill(b)).toBeCloseTo(7991.47, 1);
    expect(bill(a)).toBeCloseTo(6179.07, 1);
    expect(bill(b) - bill(a)).toBeCloseTo(1812.4, 1);
    expect(b.energiledd - a.energiledd).toBeCloseTo(105, 2);
    expect(b.effektledd - a.effektledd).toBeCloseTo(1493.5, 2);
    expect(b.elavgift - a.elavgift).toBeCloseTo(213.9, 2);
    expect(b.fastledd - a.fastledd).toBeCloseTo(0, 6);
  });

  test("5 VV.L: månedsvekter", () => {
    expect(run("VV.L", "hele_nettomraadet", peaks(2026, 1, [[100]], 10)).months[0].cost.effektledd).toBeCloseTo(5557, 2);
    expect(run("VV.L", "hele_nettomraadet", peaks(2026, 7, [[100]], 10)).months[0].cost.effektledd).toBeCloseTo(3334.2, 2);
  });

  test("6 grensen på 5 kW: Lede nedre inklusiv, Vevig øvre inklusiv", () => {
    const three = (kw: number) => peaks(2026, 5, [[kw], [kw], [kw]], 1);
    expect(run("LD.K", "hele_nettomraadet", three(5)).months[0].cost.effektledd).toBeCloseTo(367, 6);
    expect(run("VV.K", "hele_nettomraadet", three(5)).months[0].cost.effektledd).toBeCloseTo(261, 6);
    expect(run("VV.K", "hele_nettomraadet", three(5.01)).months[0].cost.effektledd).toBeCloseTo(363, 6);
  });

  test("7 LD.K: satsendringen 1. mai brukes fra riktig dato", () => {
    // 30. april og 1. mai, 100 kWh hver dag
    const start = osloLocalToUtc(2026, 4, 30, 0)[0];
    const n = 48;
    const v = new Float64Array(n).fill(100 / 24);
    const load: TimeSeries = { kind: "forbruk", startUtc: start, resolutionMin: 60, values: v, unit: "kWh", provenance: { status: "antatt", source: "test" } };
    const spot: TimeSeries = { ...load, kind: "pris", unit: "NOK/kWh", values: new Float64Array(n) };
    const r = simulate({ load, spot, buy, sell, tariff: gridTariff(def("LD.K")), taxes: noTax });
    expect(r.months.map((m) => m.cost.energiledd)).toEqual([expect.closeTo(24.38, 6), expect.closeTo(11.41, 6)]);
    expect(r.total.cost.energiledd).toBeCloseTo(35.79, 6);
  });

  test("8 LI.K: energiledd uten elavgift, elavgift separat", () => {
    // 100 kWh på dagtid (kl. 06–22) i juli
    const r = run("LI.K", "hele_nettomraadet", month(2026, 7, ({ day, hour }) => (day === 8 && hour === 12 ? 100 : 0)), ordinaryTax).months[0].cost;
    expect(r.energiledd).toBeCloseTo(22.81, 6);
    expect(r.elavgift).toBeCloseTo(7.13, 6);
    expect(r.energiledd + r.elavgift).toBeCloseTo(29.94, 6);
  });

  test("9 GL.L: nettlading kan skape ny månedstopp – spart effektledd 0", () => {
    const area = "glitre_tidligere_agder_buskerud_hadeland";
    const before = run("GL.L", area, peaks(2026, 10, [[200]], 50)).months[0];
    // Batteriet kutter den gamle toppen til 150, men lader til 200 kW en annen dag
    const after = run("GL.L", area, peaks(2026, 10, [[150], [], [], [], [], [50, 50, 200]], 50)).months[0];
    expect(after.grid!.billedKw).toBeCloseTo(200, 6);
    expect(before.cost.effektledd - after.cost.effektledd).toBeCloseTo(0, 6);
  });

  test("10 LD.L: 400 kW i ett kvarter gir 100 kW i klokketimen", () => {
    const load = month(2026, 7, ({ i }) => (i === 401 ? 100 : 0), "forbruk", 15);
    const r = run("LD.L", "hele_nettomraadet", load).months[0];
    expect(r.loadKwh).toBeCloseTo(100, 6);
    expect(r.grid!.billedKw).toBeCloseTo(100, 6);
  });

  test("11 flere målere avregnes hver for seg (ingen deling uten avtale)", () => {
    // A eksporterer 10 kWh, B importerer 10 kWh samme time: B betaler for 10 kWh
    const A = run("GL.L", "glitre_tidligere_agder_buskerud_hadeland", peaks(2026, 10, [[0]], 0));
    const B = run("GL.L", "glitre_tidligere_agder_buskerud_hadeland", peaks(2026, 10, [[10]], 0));
    expect(B.total.importKwh).toBeCloseTo(10, 6);
    expect(A.total.importKwh).toBeCloseTo(0, 6);
  });

  test("12 Lede: hovedsikringen avgjør produktet over 100 000 kWh", () => {
    const products = defs.filter((d) => d.product.forslagsvilkaar.maalepunkt_nettomraade === "LD").map((d) => ({ def: d, date: "2026-08-01" }));
    const q = { companyCode: "LD", area: "hele_nettomraadet", annualKwh: 250_000, level: "lavspent" as const, voltageV: 230 as const };
    const small = suggestTariff(products, { ...q, mainFuseA: 160 }).filter((c) => c.fit === "foreslått").map((c) => c.productId);
    const big = suggestTariff(products, { ...q, mainFuseA: 200 }).filter((c) => c.fit === "foreslått").map((c) => c.productId);
    expect(small).toEqual(["LD.K"]);
    expect(big).toEqual(["LD.L"]);
  });

  test("13 sperre og prognose: døgntariff velges aldri automatisk, 2027 er et merket anslag", () => {
    const products = defs.filter((d) => d.product.forslagsvilkaar.maalepunkt_nettomraade === "GL").map((d) => ({ def: d, date: "2026-10-01" }));
    const c = suggestTariff(products, { companyCode: "GL", area: "glitre_tidligere_agder_buskerud_hadeland", annualKwh: 300_000, level: "lavspent", mainFuseA: null, voltageV: null });
    expect(c.find((x) => x.productId === "GL.DL")?.fit).toBe("avtale");
    expect(c.filter((x) => x.fit === "foreslått").map((x) => x.productId)).toEqual(["GL.L"]);
    // 2027: ingen bekreftet pris – satsene lånes fra 2026 og merkes
    const v = versionAt(def("GL.L", "glitre_tidligere_agder_buskerud_hadeland"), { year: 2027, month: 1, day: 15 });
    expect(v.shiftedFrom).toBe("2026");
    const r = run("GL.L", "glitre_tidligere_agder_buskerud_hadeland", peaks(2027, 1, [[100]], 10));
    expect(r.tariffNotes.shiftedFrom).toEqual(["2026"]);
    expect(r.months[0].grid!.shiftedFrom).toBe("2026");
  });
});

describe("tariffregler", () => {
  test("alle 69 prisversjoner er med, og hvert produkt/område har sammenhengende datoer", () => {
    expect(defs.reduce((a, d) => a + d.versions.length, 0)).toBe(69);
    for (const d of defs)
      for (let i = 1; i < d.versions.length; i++) expect(d.versions[i].dekket_fra).toBe(d.versions[i - 1].dekket_til_eksklusiv);
  });

  test("kapasitetstrinn: øverste trinn uten grense", () => {
    const trinn = [{ til_kw: 5, kr_per_mnd: 100 }, { til_kw: null, kr_per_mnd: 500 }];
    expect(capacityStep(trinn, 4.99).nok).toBe(100);
    expect(capacityStep(trinn, 5).nok).toBe(500);
    expect(capacityStep(trinn, 1000).nok).toBe(500);
  });

  test("uavklart effektregel gir delberegning, ikke null", () => {
    const r = run("NV.L", "hele_nettomraadet", peaks(2026, 3, [[300]], 50));
    expect(r.months[0].grid!.powerMissing).toBeTruthy();
    expect(r.tariffNotes.missing.length).toBeGreaterThan(0);
  });

  test("påstemplet effekt: kutt i målt topp sparer ikke effektledd", () => {
    const a = run("NV.T5", "hele_nettomraadet", peaks(2026, 3, [[300]], 50), noTax, { contractedKw: 150 }).months[0];
    const b = run("NV.T5", "hele_nettomraadet", peaks(2026, 3, [[100]], 50), noTax, { contractedKw: 150 }).months[0];
    expect(a.cost.effektledd).toBeCloseTo(b.cost.effektledd, 6);
    expect(a.grid!.billedKw).toBe(150);
  });

  test("dag/natt-energiledd: 06–22 er klokketimene 06–21", () => {
    // Elvia K (jan): dag 20,99 hverdager utenom helligdager, ellers 12,99
    const at = (day: number, hour: number) => run("EL.K", "hele_nettomraadet", month(2026, 1, (p) => (p.day === day && p.hour === hour ? 100 : 0))).months[0].cost.energiledd;
    expect(at(7, 6)).toBeCloseTo(20.99, 6); // onsdag 06
    expect(at(7, 21)).toBeCloseTo(20.99, 6);
    expect(at(7, 22)).toBeCloseTo(12.99, 6);
    expect(at(1, 12)).toBeCloseTo(12.99, 6); // 1. nyttårsdag
    expect(at(10, 12)).toBeCloseTo(12.99, 6); // lørdag
  });

  void HOUR;
});
