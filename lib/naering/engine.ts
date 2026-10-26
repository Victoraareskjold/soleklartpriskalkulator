// Beregningsmotoren: energiflyt per intervall og regning per måned.
// Ren funksjon – samme grunnlag gir alltid samme svar. Ingen I/O.
//
// Per intervall (bak ett målepunkt, uten batteri i trinn 1):
//   egenbruk = min(last, produksjon)
//   import   = last − egenbruk
//   eksport  = min(produksjon − egenbruk, eksportgrense)   rest = avkortet
// Kostnad:
//   kraft    = import × (spot + påslag)          + månedsgebyr (forsvinner ikke med solceller)
//   nettleie = fastledd + import × energiledd + effektledd(maks import i vinduet)
//   avgift   = import × elavgift
//   salg     = eksport × (spot − fratrekk)       (kan bli negativ ved negative priser)

import type { TimeSeries } from "./types";
import type { BuyAgreement, SellAgreement, Taxes, Tariff } from "./tariff";
import { HOUR, fmtLocal, osloParts } from "./time";
import { norwegianHolidays } from "./profiles";

export const ENGINE_VERSION = "naering-0.1.0";

export interface EngineInput {
  load: TimeSeries;
  pv?: TimeSeries | null;
  /** Skalering av PV (degradering i år t). 1 = som serien. */
  pvFactor?: number;
  spot: TimeSeries;
  buy: BuyAgreement;
  sell: SellAgreement;
  tariff: Tariff;
  taxes: Taxes;
  exportLimitKw?: number | null;
  /** Analyseperiode [fra, til) i UTC. Standard: hele forbruksserien. */
  fromUtc?: number;
  toUtc?: number;
}

export interface MonthResult {
  month: string; // "2024-01"
  days: number;
  loadKwh: number;
  pvKwh: number;
  selfKwh: number;
  importKwh: number;
  exportKwh: number;
  curtailedKwh: number;
  peakKw: number;
  peakAt: string;
  cost: {
    kraft: number;
    kraftGebyr: number;
    fastledd: number;
    energiledd: number;
    effektledd: number;
    elavgift: number;
    salg: number; // inntekt (positiv)
    netto: number; // sum kostnader − salg
  };
}

export interface EngineResult {
  months: MonthResult[];
  total: Omit<MonthResult, "month" | "peakAt" | "days" | "peakKw"> & { days: number };
  checks: { maxBalanceErrorKwh: number; intervals: number };
}

/** Gjeldende satser på en lokal dato, inkludert satsendringer midt i året. */
export function rateAt(t: Tariff, d: { year: number; month: number; day: number }) {
  const z = (x: number) => String(x).padStart(2, "0");
  const iso = `${d.year}-${z(d.month)}-${z(d.day)}`;
  const r = {
    energyOrePerKwh: t.energyOrePerKwh,
    summerNokPerKwMonth: t.power?.summerNokPerKwMonth ?? 0,
    winterNokPerKwMonth: t.power?.winterNokPerKwMonth ?? 0,
  };
  for (const c of [...(t.rateChanges ?? [])].sort((a, b) => a.from.localeCompare(b.from)))
    if (c.from <= iso) {
      if (c.energyOrePerKwh != null) r.energyOrePerKwh = c.energyOrePerKwh;
      if (c.summerNokPerKwMonth != null) r.summerNokPerKwMonth = c.summerNokPerKwMonth;
      if (c.winterNokPerKwMonth != null) r.winterNokPerKwMonth = c.winterNokPerKwMonth;
    }
  return r;
}

function at(s: TimeSeries, t: number): number {
  const i = (t - s.startUtc) / (s.resolutionMin * 60_000);
  return Number.isInteger(i) && i >= 0 && i < s.values.length ? s.values[i] : NaN;
}

export function simulate(inp: EngineInput): EngineResult {
  const { load, pv, spot, buy, sell, tariff, taxes } = inp;
  if (load.resolutionMin !== 60) throw new Error("Trinn 1 regner per time – kvartersdata må aggregeres først (logges).");
  const from = inp.fromUtc ?? load.startUtc;
  const to = inp.toUtc ?? load.startUtc + load.values.length * HOUR;
  const pvF = inp.pvFactor ?? 1;
  const limitKwh = inp.exportLimitKw == null ? Infinity : inp.exportLimitKw; // per time
  const months = new Map<string, MonthResult>();
  const holidaysByYear = new Map<number, Set<string>>();
  const daysSeen = new Map<string, Set<number>>();
  let maxErr = 0;
  let n = 0;

  for (let t = from; t < to; t += HOUR) {
    const L = at(load, t);
    const P = pv ? at(pv, t) * pvF : 0;
    const S = at(spot, t);
    if (!Number.isFinite(L)) throw new Error(`Forbruk mangler ${fmtLocal(t)} – beregnes ikke (ingen stille nullverdier).`);
    if (!Number.isFinite(P)) throw new Error(`Produksjon mangler ${fmtLocal(t)}.`);
    if (!Number.isFinite(S)) throw new Error(`Spotpris mangler ${fmtLocal(t)}.`);

    const self = Math.min(L, P);
    const imp = L - self;
    const surplus = P - self;
    const exp = Math.min(surplus, limitKwh);
    const curt = surplus - exp;
    maxErr = Math.max(maxErr, Math.abs(L - self - imp), Math.abs(P - self - exp - curt));

    const lp = osloParts(t);
    const key = `${lp.year}-${String(lp.month).padStart(2, "0")}`;
    let m = months.get(key);
    if (!m) {
      m = {
        month: key, days: 0, loadKwh: 0, pvKwh: 0, selfKwh: 0, importKwh: 0, exportKwh: 0, curtailedKwh: 0, peakKw: 0, peakAt: "",
        cost: { kraft: 0, kraftGebyr: 0, fastledd: 0, energiledd: 0, effektledd: 0, elavgift: 0, salg: 0, netto: 0 },
      };
      months.set(key, m);
      daysSeen.set(key, new Set());
    }
    daysSeen.get(key)!.add(lp.day);
    m.loadKwh += L;
    m.pvKwh += P;
    m.selfKwh += self;
    m.importKwh += imp;
    m.exportKwh += exp;
    m.curtailedKwh += curt;
    m.cost.kraft += imp * (S + buy.markupOrePerKwh / 100);
    m.cost.energiledd += (imp * rateAt(tariff, lp).energyOrePerKwh) / 100;
    m.cost.elavgift += (imp * taxes.elavgiftOrePerKwh) / 100;
    m.cost.salg += exp * (S - sell.deductionOrePerKwh / 100);

    const pw = tariff.power;
    if (pw) {
      let hol = holidaysByYear.get(lp.year);
      if (!hol) holidaysByYear.set(lp.year, (hol = norwegianHolidays(lp.year)));
      const z = (x: number) => String(x).padStart(2, "0");
      const inWin =
        pw.window.weekdays.includes(lp.weekday) &&
        lp.hour >= pw.window.fromHour &&
        lp.hour < pw.window.toHour &&
        !(pw.window.excludeHolidays && hol.has(`${lp.year}-${z(lp.month)}-${z(lp.day)}`));
      if (inWin && imp > m.peakKw) {
        m.peakKw = imp; // kWh på én time = kW i snitt
        m.peakAt = fmtLocal(t);
      }
    }
    n++;
  }

  const yearDays = new Map<number, number>();
  for (const m of months.values()) {
    const y = +m.month.slice(0, 4);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    yearDays.set(y, leap ? 366 : 365);
    m.days = daysSeen.get(m.month)!.size;
    const fullMonthDays = new Date(Date.UTC(y, +m.month.slice(5), 0)).getUTCDate();
    m.cost.fastledd =
      tariff.fixedAllocation === "per_dag"
        ? (tariff.fixedNokPerYear / yearDays.get(y)!) * m.days
        : (tariff.fixedNokPerYear / 12) * (m.days / fullMonthDays);
    m.cost.kraftGebyr = buy.monthlyFeeNok * (m.days / fullMonthDays);
    if (tariff.power) {
      const mon = +m.month.slice(5);
      const r = rateAt(tariff, { year: y, month: mon, day: 1 });
      const rate = tariff.power.summerMonths.includes(mon) ? r.summerNokPerKwMonth : r.winterNokPerKwMonth;
      // Delmåned (hittil i år): effektledd tas med for påbegynt måned slik nettselskapet fakturerer
      m.cost.effektledd = m.peakKw * rate;
    }
    const c = m.cost;
    c.netto = c.kraft + c.kraftGebyr + c.fastledd + c.energiledd + c.effektledd + c.elavgift - c.salg;
  }

  const list = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const total = list.reduce(
    (acc, m) => {
      for (const k of ["loadKwh", "pvKwh", "selfKwh", "importKwh", "exportKwh", "curtailedKwh", "days"] as const) acc[k] += m[k];
      for (const k of Object.keys(acc.cost) as (keyof MonthResult["cost"])[]) acc.cost[k] += m.cost[k];
      return acc;
    },
    {
      days: 0, loadKwh: 0, pvKwh: 0, selfKwh: 0, importKwh: 0, exportKwh: 0, curtailedKwh: 0,
      cost: { kraft: 0, kraftGebyr: 0, fastledd: 0, energiledd: 0, effektledd: 0, elavgift: 0, salg: 0, netto: 0 },
    },
  );
  return { months: list, total, checks: { maxBalanceErrorKwh: maxErr, intervals: n } };
}

/** Besparelse per komponent: før − etter (positivt = kunden sparer). */
export function savings(before: EngineResult, after: EngineResult) {
  const b = before.total.cost;
  const a = after.total.cost;
  return {
    kraft: b.kraft - a.kraft,
    nettleieEnergi: b.energiledd - a.energiledd,
    effektledd: b.effektledd - a.effektledd,
    elavgift: b.elavgift - a.elavgift,
    fastOgGebyr: b.fastledd + b.kraftGebyr - (a.fastledd + a.kraftGebyr), // skal være 0
    salg: a.salg - b.salg,
    total: b.netto - a.netto,
  };
}
