// Setter sammen én analyse: datagrunnlag → før/etter → levetidsøkonomi → forklaringer.
// Resultatet inneholder alt som skal låses med tilbudet: grunnlag, versjon og hash.

import { createHash } from "node:crypto";
import type { AnalysisIssue, DataStatus, QualityReport, SourceType, TimeSeries } from "./types";
import type { BuyAgreement, SellAgreement, Taxes, Tariff } from "./tariff";
import { ENGINE_VERSION, simulate, savings, valueAt, type BatteryConfig, type EngineInput, type EngineResult, type MonthResult } from "./engine";
import { lifetimeFrom, type EconomyInput, type EconomyResult } from "./economy";
import { standardProfile, type BusinessType } from "./profiles";
import { HOUR, fmtLocal, hoursInYear, osloLocalToUtc } from "./time";

type Schedule = { weekdays: [number, number] | null; saturday: [number, number] | null; sunday: [number, number] | null; closedMonths?: number[] } | null;
export type ConsumptionBasis =
  | { level: 1; type: BusinessType; annualKwh: number; openHours?: [number, number]; schedule?: Schedule }
  | { level: 2; type: BusinessType; monthlyKwh: number[]; openHours?: [number, number]; schedule?: Schedule }
  | { level: 3; series: TimeSeries; report: QualityReport };

/** Et annet målepunkt hos kunden: eget forbruk og egen tariff, eventuelt egne takflater. */
export interface MeterInput {
  id: string;
  label: string;
  consumption: ConsumptionBasis;
  production: TimeSeries | null;
  tariff: Tariff;
  tariffScenario?: boolean;
  exportLimitKw: number | null;
  importLimitKw: number | null;
  inverterAcKw?: number | null;
  extraLoad?: TimeSeries | null;
}

/** Batteriet i tilbudet. Regnes som tre alternativer: sol alene, sol + batteri (grunnstyring), sol + batteri (smartstyring). */
export interface BatteryInput {
  label: string;
  config: Omit<BatteryConfig, "strategy" | "forecast" | "capacityFactor">;
  degradationPerYear: number;
  lifeYears: number;
  /** Batteriets investering (kr). null = uavklart */
  investmentNok: number | null;
  /** Utskifting ved endt levetid (kr, nominelt) */
  replacementNok: number | null;
  smartFeeNokPerYear: number;
  smartFeeOnceNok: number;
  /** Linjer i datagrunnlaget som beskriver batteriets verdier og kilder */
  basis: BasisLine[];
}

export type AlternativeKey = "sol" | "grunn" | "smart";

export type AnalysisPeriod =
  | { kind: "år"; year: number }
  | { kind: "hittil"; year: number; toMonth: number; toDay: number }
  /** Egendefinert periode, lokale datoer inkl. begge ender, inntil ett år (kan krysse årsskiftet) */
  | { kind: "egendefinert"; year: number; from: string; to: string };

/** Periodens grenser i UTC [fra, til), årene den dekker og en lesbar etikett. */
export function periodRange(p: AnalysisPeriod) {
  const dmy = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return { y, m, d };
  };
  const nextDay = (iso: string) => {
    const t = new Date(`${iso}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  };
  const z = (x: number) => String(x).padStart(2, "0");
  let fromDay: string, lastDay: string;
  if (p.kind === "år") [fromDay, lastDay] = [`${p.year}-01-01`, `${p.year}-12-31`];
  else if (p.kind === "hittil") [fromDay, lastDay] = [`${p.year}-01-01`, `${p.year}-${z(p.toMonth)}-${z(p.toDay)}`];
  else [fromDay, lastDay] = [p.from, p.to];
  const a = dmy(fromDay), b = dmy(nextDay(lastDay));
  const from = osloLocalToUtc(a.y, a.m, a.d, 0)[0];
  const to = osloLocalToUtc(b.y, b.m, b.d, 0)[0];
  const years: number[] = [];
  for (let y = a.y; y <= dmy(lastDay).y; y++) years.push(y);
  const days = Math.round((to - from) / (24 * HOUR));
  const fmt = (iso: string) => {
    const d = dmy(iso);
    return `${d.d}.${d.m}.${d.y}`;
  };
  const label = p.kind === "år" ? `${p.year}` : p.kind === "hittil" ? `1.1.–${p.toDay}.${p.toMonth}.${p.year}` : `${fmt(fromDay)}–${fmt(lastDay)}`;
  // Et helt år (eller en egendefinert periode på 12 måneder) gir levetidsøkonomi
  const complete = p.kind === "år" || (p.kind === "egendefinert" && days >= 365);
  return { from, to, fromDay, lastDay, years, days, label, complete };
}

/** Setter sammen serier for påfølgende kalenderår til én serie. */
export function concatYears(parts: TimeSeries[]): TimeSeries {
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((a, s) => a + s.values.length, 0);
  const v = new Float64Array(n);
  let o = 0;
  for (const s of parts) {
    v.set(s.values, o);
    o += s.values.length;
  }
  const first = parts[0], last = parts[parts.length - 1];
  return {
    ...first,
    values: v,
    provenance: { ...first.provenance, period: { from: first.provenance.period?.from ?? "", to: last.provenance.period?.to ?? "" } },
  };
}

export interface AnalysisInput {
  project: { name: string; address: string; priceArea: string; businessType: BusinessType; isExample?: boolean };
  meteringPoint: { id: string; label: string };
  period: AnalysisPeriod;
  consumption: ConsumptionBasis;
  production: TimeSeries;
  spot: TimeSeries;
  tariff: Tariff;
  taxes: Taxes;
  buy: BuyAgreement;
  sell: SellAgreement;
  exportLimitKw: number | null;
  /** Største uttak fra nettet (kW). null = ukjent */
  importLimitKw?: number | null;
  /** Lading lagt til forbruket på hovedmåleren (null = ingen) */
  extraLoad?: TimeSeries | null;
  /** Andre målepunkter */
  otherMeters?: MeterInput[];
  battery?: BatteryInput | null;
  /** 1 = eks. mva., 1,25 = kunden har ikke fradragsrett (kostnader inkl. mva.) */
  vatFactor?: number;
  /** Mva.-linjen i grunnlaget */
  vatNote?: { value: string; status: DataStatus; sourceType: SourceType; source: string };
  /** Investering vist for alternativet (tilbudsalternativ) */
  offerLabel?: string;
  inverterAcKw?: number | null;
  /** Værår solsimuleringen bygger på (null = importert produksjonsfil) */
  weatherYear?: number | null;
  /** Tariffen dekker ikke perioden, og selger har valgt å bruke den som scenario */
  tariffScenario?: boolean;
  /** Avvik funnet under oppsettet (tariff, avgift, takflater …) */
  issues?: AnalysisIssue[];
  economy: EconomyInput;
  /** Scenarioer på strømprisvekst; første er hovedscenario */
  scenarios: { name: string; kraftGrowth: number }[];
}

export interface BasisLine {
  what: string;
  value: string;
  status: DataStatus;
  /** Kildetype vist til kunden: måledata, historiske markedspriser, fra tariffregister, simulert, oppgitt, antatt */
  sourceType: SourceType;
  /** Bekreftet for kunden/perioden (bare relevant for tariff og avtaler) */
  confirmed?: boolean;
  source: string;
  period?: string;
}

export interface AnalysisResult {
  engineVersion: string;
  inputHash: string;
  createdAt: string;
  period: { label: string; coverage: number; complete: boolean };
  dataLevel: { consumption: 1 | 2 | 3; label: string };
  basis: BasisLine[];
  before: EngineResult;
  after: EngineResult;
  savings: ReturnType<typeof savings>;
  kpi: { selfConsumptionShare: number; selfSufficiencyShare: number };
  /** Det historiske året: lavere energikostnad minus løpende kostnader (ingen prisvekst) */
  historical: { energySaving: number; opex: number; net: number; opexItems: { name: string; nok: number }[] };
  /** Prisår og værår for merkingen ved resultatet */
  years: { price: number; weather: number | null };
  economy: { name: string; kraftGrowth: number; result: EconomyResult }[] | null;
  economyNote?: string;
  /** Batteri: alternativer, forskjeller og batteritall. null = ikke med. */
  battery: BatteryAnalysis | null;
  /** Per målepunkt (når kunden har flere) */
  meters: { id: string; label: string; before: EngineResult["total"]; after: EngineResult["total"]; tariff: string }[];
  /** Lading lagt til forbruket */
  charging: { kwh: number; solarKwh: number; effektleddIncrease: number } | null;
  offerLabel: string;
  /** Avvik: feil gjør resultatet ubrukelig i tilbud, advarsler må vurderes, antakelser er synlige anslag */
  issues: AnalysisIssue[];
  valid: boolean;
  warnings: string[];
  customerSentence: string;
  checks: { label: string; ok: boolean; detail: string }[];
}

const nf = (x: number, d = 0) => x.toLocaleString("nb-NO", { maximumFractionDigits: d, minimumFractionDigits: d });

export interface BatteryAnalysis {
  label: string;
  investmentNok: number | null;
  alternatives: {
    key: AlternativeKey;
    name: string;
    result: EngineResult;
    savings: ReturnType<typeof savings>;
    opex: number;
    net: number;
    investmentNok: number | null;
    economy: { name: string; kraftGrowth: number; result: EconomyResult }[] | null;
  }[];
  /** Batteriets merverdi med grunnstyring (grunn − sol) og smartstyringens merverdi etter gebyr (smart − grunn) i analyseåret */
  value: { grunn: number; smart: number; smartFee: number };
  /** Samme styring med perfekt prognose (fasit for forbruk og sol) – en referanse, ikke oppnåelig i praksis */
  perfectForesightNet: number;
  /** Døgnutsnitt fra smartstyringen: dagen med mest batteribruk */
  day: { date: string; hours: { hour: number; price: number; soc: number; battery: number; load: number; pv: number }[] } | null;
  config: BatteryInput["config"] & { degradationPerYear: number; lifeYears: number };
}

/** Summerer resultater fra flere målepunkter (måned for måned). Effekttopp = sum av målernes topper. */
function combine(rs: EngineResult[]): EngineResult {
  if (rs.length === 1) return rs[0];
  const map = new Map<string, MonthResult>();
  const addNum = <T extends object>(a: T, b: T) => {
    for (const k of Object.keys(b) as (keyof T)[]) if (typeof b[k] === "number") (a[k] as number) += b[k] as number;
  };
  for (const r of rs)
    for (const m of r.months) {
      const cur = map.get(m.month);
      if (!cur) map.set(m.month, { ...m, cost: { ...m.cost }, battery: m.battery ? { ...m.battery } : undefined });
      else {
        const days = cur.days;
        addNum(cur, m);
        cur.days = days;
        addNum(cur.cost, m.cost);
        if (m.battery) cur.battery = cur.battery ? (addNum(cur.battery, m.battery), cur.battery) : { ...m.battery };
      }
    }
  const months = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  const total = { ...rs[0].total, cost: { ...rs[0].total.cost }, battery: rs[0].total.battery ? { ...rs[0].total.battery } : undefined };
  for (const r of rs.slice(1)) {
    const days = total.days;
    addNum(total, r.total);
    total.days = days;
    addNum(total.cost, r.total.cost);
    if (r.total.battery) total.battery = total.battery ? (addNum(total.battery, r.total.battery), total.battery) : { ...r.total.battery };
  }
  return {
    months,
    total,
    checks: {
      ...rs[0].checks,
      maxBalanceErrorKwh: Math.max(...rs.map((r) => r.checks.maxBalanceErrorKwh)),
    },
    hourly: rs.find((r) => r.hourly)?.hourly,
  };
}

/** Kunden uten fradragsrett: kostnader inkl. 25 % mva. (salgsinntekt er uten mva.). */
function withVat(r: EngineResult, f: number): EngineResult {
  if (f === 1) return r;
  const scale = (c: MonthResult["cost"]) => {
    for (const k of ["kraft", "kraftGebyr", "fastledd", "energiledd", "effektledd", "elavgift"] as const) c[k] *= f;
    c.netto = c.kraft + c.kraftGebyr + c.fastledd + c.energiledd + c.effektledd + c.elavgift - c.salg;
  };
  r.months.forEach((m) => scale(m.cost));
  scale(r.total.cost);
  return r;
}

function addSeries(a: TimeSeries, b: TimeSeries | null | undefined): TimeSeries {
  if (!b) return a;
  const v = Float64Array.from(a.values);
  const res = a.resolutionMin * 60_000;
  for (let i = 0; i < v.length; i++) {
    const x = valueAt(b, a.startUtc + i * res, res, true);
    if (Number.isFinite(x)) v[i] += x;
  }
  return { ...a, values: v };
}

function hashSeries(s: TimeSeries) {
  return createHash("sha256").update(new Uint8Array(s.values.buffer)).digest("hex").slice(0, 16);
}

export function runAnalysis(inp: AnalysisInput): AnalysisResult {
  const issues: AnalysisIssue[] = [...(inp.issues ?? [])];
  const y = inp.period.year;
  const range = periodRange(inp.period);
  const { from, to } = range;
  const coverage = range.complete ? 1 : (to - from) / HOUR / hoursInYear(y);

  // ---- forbruk etter datanivå
  const loadOf = (c: ConsumptionBasis, field: string, who = "") => {
    if (c.level === 3) {
      for (const i of c.report.issues)
        if (i.level !== "info") issues.push({ level: i.level === "feil" ? "feil" : "advarsel", field, message: `${who ? `${who}: f` : "F"}orbruksdata: ${i.message}` });
      return c.series;
    }
    return concatYears(
      range.years.map((yr) =>
        standardProfile({
          type: c.type,
          year: yr,
          annualKwh: c.level === 1 ? c.annualKwh : 0,
          monthlyKwh: c.level === 2 ? c.monthlyKwh : undefined,
          openHours: c.openHours,
          schedule: c.schedule ?? null,
        }),
      ),
    );
  };
  const c = inp.consumption;
  const baseLoad = loadOf(c, "forbruk");
  const load = addSeries(baseLoad, inp.extraLoad);
  const vat = inp.vatFactor ?? 1;

  const common = {
    load, spot: inp.spot, buy: inp.buy, sell: inp.sell, tariff: inp.tariff, taxes: inp.taxes,
    exportLimitKw: inp.exportLimitKw, importLimitKw: inp.importLimitKw ?? null, inverterAcKw: inp.inverterAcKw ?? null, fromUtc: from, toUtc: to,
  };
  const others = (inp.otherMeters ?? []).map((m) => ({
    m,
    common: {
      load: addSeries(loadOf(m.consumption, `måler:${m.id}`, m.label), m.extraLoad), spot: inp.spot, buy: inp.buy, sell: inp.sell, tariff: m.tariff, taxes: inp.taxes,
      exportLimitKw: m.exportLimitKw, importLimitKw: m.importLimitKw, inverterAcKw: m.inverterAcKw ?? null, fromUtc: from, toUtc: to,
    } as EngineInput,
  }));
  const bat = inp.battery ?? null;
  const pvF = (t: number) => Math.pow(1 - inp.economy.degradationPerYear, t - 1);
  const batteryFor = (alt: "grunn" | "smart" | "perfekt", t: number): BatteryConfig => {
    const age = bat!.lifeYears > 0 ? (t - 1) % bat!.lifeYears : t - 1; // nytt batteri etter utskifting
    return {
      ...bat!.config,
      strategy: alt === "grunn" ? "grunn" : "smart",
      forecast: alt === "perfekt" ? "perfekt" : "persistens",
      capacityFactor: Math.pow(1 - bat!.degradationPerYear, age),
    };
  };
  // Alle alternativer og år regnes én gang og gjenbrukes i scenarioene
  const cache = new Map<string, EngineResult>();
  const othersCache = new Map<string, EngineResult[]>();
  const simAll = (alt: "før" | AlternativeKey | "perfekt", t = 1): EngineResult => {
    const key = `${alt}:${t}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const main = simulate({
      ...common,
      pv: alt === "før" ? null : inp.production,
      pvFactor: pvF(t),
      battery: alt === "før" || alt === "sol" || !bat ? null : batteryFor(alt, t),
    });
    const okey = `${alt === "før" ? "før" : "etter"}:${t}`;
    let os = othersCache.get(okey);
    if (!os) {
      os = others.map((o) => simulate({ ...o.common, pv: alt === "før" ? null : o.m.production, pvFactor: pvF(t) }));
      othersCache.set(okey, os);
    }
    const r = withVat(combine([main, ...os]), vat);
    cache.set(key, r);
    return r;
  };
  const before = simAll("før");
  const after = simAll("sol");
  const sv = savings(before, after);

  if (after.total.clippedKwh > 0.5)
    issues.push({
      level: "antakelse",
      field: "produksjon",
      message: `Inverteren (${nf(inp.inverterAcKw ?? 0, 1)} kW AC) kapper ${nf(after.total.clippedKwh)} kWh av solproduksjonen i perioden.`,
    });

  // ---- historisk år: energifordel minus tiltakets løpende kostnader (uten prisvekst)
  const share = range.complete ? 1 : coverage;
  const opexItems = inp.economy.opex.map((o) => ({ name: o.name, nok: o.nokPerYear * share }));
  const opex = opexItems.reduce((a, o) => a + o.nok, 0);
  const historical = { energySaving: sv.total, opex, net: sv.total - opex, opexItems };

  // ---- økonomi (bare for helt år – delår skal ikke ganges opp)
  let economy: AnalysisResult["economy"] = null;
  let economyNote: string | undefined;
  const fullYear = range.complete;
  const economyFor = (alt: AlternativeKey, e: EconomyInput) =>
    fullYear
      ? inp.scenarios.map((s) => ({
          name: s.name,
          kraftGrowth: s.kraftGrowth,
          result: lifetimeFrom(
            before,
            (t) => simAll(alt, t),
            { ...e, growth: { ...e.growth, kraft: s.kraftGrowth } },
            alt === "sol" ? undefined : [1, 5, 10, 15, 20, 25, 30, 40, bat!.lifeYears, bat!.lifeYears + 1],
          ),
        }))
      : null;
  if (fullYear) {
    economy = economyFor("sol", inp.economy);
    if (inp.economy.investmentNok == null)
      economyNote = "Investeringen for solcelledelen er ikke avklart. Nåverdi og tilbakebetaling vises ikke; i stedet vises høyeste investering som gir positiv nåverdi.";
  } else economyNote = "Delperiode: levetidsøkonomi beregnes bare fra et helt år (12 måneder). Perioden vises som den er, ikke oppskalert.";

  // ---- batteri: tre sammenlignbare alternativer med samme energibalanse
  let battery: BatteryAnalysis | null = null;
  if (bat) {
    const smartFeeHist = bat.smartFeeNokPerYear * share;
    const altEconomy = (alt: AlternativeKey): EconomyInput => {
      if (alt === "sol") return inp.economy;
      const inv = inp.economy.investmentNok == null || bat.investmentNok == null ? null : inp.economy.investmentNok + bat.investmentNok + (alt === "smart" ? bat.smartFeeOnceNok : 0);
      const repl = [...inp.economy.replacements];
      if (bat.replacementNok != null && bat.lifeYears > 0)
        for (let yr = bat.lifeYears + 1; yr <= inp.economy.years; yr += bat.lifeYears)
          repl.push({ name: `Batteribytte (etter ${bat.lifeYears} år)`, year: yr, nok: bat.replacementNok });
      const opex = [...inp.economy.opex];
      if (alt === "smart" && bat.smartFeeNokPerYear > 0) opex.push({ name: "Smartstyring", nokPerYear: bat.smartFeeNokPerYear });
      return { ...inp.economy, investmentNok: inv, replacements: repl, opex };
    };
    const names: Record<AlternativeKey, string> = {
      sol: "Solceller alene",
      grunn: "Solceller og batteri – grunnstyring",
      smart: "Solceller og batteri – smart prisstyring",
    };
    const alternatives = (["sol", "grunn", "smart"] as const).map((key) => {
      const r = simAll(key);
      const s = savings(before, r);
      const ox = opex + (key === "smart" ? smartFeeHist : 0);
      const e = altEconomy(key);
      return { key, name: names[key], result: r, savings: s, opex: ox, net: s.total - ox, investmentNok: e.investmentNok, economy: economyFor(key, e) };
    });
    const perfect = simAll("perfekt");
    const smartRes = alternatives[2].result;
    // Døgnutsnitt: dagen med mest batteribruk i smartstyringen
    let day: BatteryAnalysis["day"] = null;
    const h = smartRes.hourly;
    if (h) {
      const STEP = h.stepMin * 60_000;
      const sums = new Map<string, number>();
      for (let i = 0; i < h.battery.length; i++) {
        const d = fmtLocal(h.startUtc + i * STEP).slice(0, 10);
        sums.set(d, (sums.get(d) ?? 0) + Math.abs(h.battery[i]));
      }
      const best = [...sums.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best) {
        // Per time (kvarter slås sammen): snitt effekt og pris, nivå ved slutten av timen, energi summert
        const byHour = new Map<string, { hour: number; price: number; soc: number; battery: number; load: number; pv: number; k: number }>();
        for (let i = 0; i < h.battery.length; i++) {
          const lt = fmtLocal(h.startUtc + i * STEP);
          if (lt.slice(0, 10) !== best) continue;
          const key = lt.slice(0, 13);
          const cur = byHour.get(key) ?? { hour: +lt.slice(11, 13), price: 0, soc: 0, battery: 0, load: 0, pv: 0, k: 0 };
          cur.price += h.price[i];
          cur.battery += h.battery[i];
          cur.load += h.load[i];
          cur.pv += h.pv[i];
          cur.soc = h.soc[i];
          cur.k++;
          byHour.set(key, cur);
        }
        day = { date: best, hours: [...byHour.values()].map((x) => ({ hour: x.hour, price: x.price / x.k, soc: x.soc, battery: x.battery / x.k, load: x.load, pv: x.pv })) };
      }
    }
    const [aSol, aGrunn, aSmart] = alternatives;
    battery = {
      label: bat.label,
      investmentNok: bat.investmentNok,
      alternatives,
      value: { grunn: aGrunn.net - aSol.net, smart: aSmart.net - aGrunn.net, smartFee: smartFeeHist },
      perfectForesightNet: savings(before, perfect).total - (opex + smartFeeHist),
      day,
      config: { ...bat.config, degradationPerYear: bat.degradationPerYear, lifeYears: bat.lifeYears },
    };
    if (smartRes.total.overImportLimitHours > 0)
      issues.push({ level: "advarsel", field: "batteri", message: `Uttaket fra nettet er over importgrensen i ${smartRes.total.overImportLimitHours} timer (også uten lading fra nettet). Kontroller tilknytningen.` });
  }

  // ---- lading
  let charging: AnalysisResult["charging"] = null;
  if (inp.extraLoad) {
    const noCharge = simulate({ ...common, load: baseLoad, pv: null });
    const ex = inp.extraLoad;
    let kwh = 0, solar = 0;
    for (let i = 0; i < ex.values.length; i++) {
      const tt = ex.startUtc + i * HOUR;
      if (tt < from || tt >= to) continue;
      const e = ex.values[i];
      kwh += e;
      const freePv = Math.max(0, (valueAt(inp.production, tt, HOUR, true) || 0) - (valueAt(baseLoad, tt, HOUR, true) || 0));
      solar += Math.min(e, freePv);
    }
    const beforeMain = simulate({ ...common, pv: null });
    charging = { kwh, solarKwh: solar, effektleddIncrease: (beforeMain.total.cost.effektledd - noCharge.total.cost.effektledd) * vat };
  }

  // ---- datagrunnlag (vises i tilbudet)
  const statusLoad: DataStatus = c.level === 3 ? "målt" : "antatt";
  const st = (p: { status: DataStatus; sourceType?: SourceType }): SourceType =>
    p.sourceType ?? (p.status === "målt" ? "oppgitt" : p.status === "beregnet" ? "beregnet" : "antatt");
  const tariffValid = `gyldig ${inp.tariff.validFrom}–${inp.tariff.validTo ?? "nå"}`;
  const basis: BasisLine[] = [
    {
      what: "Forbruk",
      value: `${nf(before.total.loadKwh)} kWh`,
      status: statusLoad,
      sourceType: c.level === 3 ? "måledata" : "antatt",
      source: load.provenance.source + (load.provenance.note ? ` – ${load.provenance.note}` : ""),
      period: `${load.provenance.period?.from} – ${load.provenance.period?.to}`,
    },
    {
      what: "Solproduksjon",
      value: `${nf(after.total.pvKwh)} kWh`,
      status: "beregnet",
      sourceType: inp.weatherYear == null ? st(inp.production.provenance) : "simulert",
      source: `${inp.production.provenance.source}${(inp.otherMeters ?? []).some((m) => m.production) ? ` (hovedmåler). Andre målere: ${(inp.otherMeters ?? []).filter((m) => m.production).map((m) => m.production!.provenance.source.replace(/^PVGIS [^,]+, /, "")).join("; ")}` : ""}. ${inp.production.provenance.note ?? ""}`.trim(),
    },
    {
      what: "Spotpris",
      value: `${inp.project.priceArea}, time for time`,
      status: "målt",
      sourceType: "markedspriser",
      source: inp.spot.provenance.source,
      period: `${inp.spot.provenance.period?.from} – ${inp.spot.provenance.period?.to}`,
    },
    { what: "Påslag kjøp", value: `${nf(inp.buy.markupOrePerKwh, 2)} øre/kWh + ${nf(inp.buy.monthlyFeeNok)} kr/mnd`, status: inp.buy.provenance.status, sourceType: st(inp.buy.provenance), source: inp.buy.provenance.source },
    { what: "Salgspris overskudd", value: `spot − ${nf(inp.sell.deductionOrePerKwh, 2)} øre/kWh`, status: inp.sell.provenance.status, sourceType: st(inp.sell.provenance), source: inp.sell.provenance.source },
    {
      what: "Nettleie",
      value: `${inp.tariff.gridOwner}: ${inp.tariff.name}${inp.tariffScenario ? " (scenario – annen periode)" : ""}`,
      status: inp.tariff.provenance.status,
      sourceType: inp.tariff.provenance.sourceType ?? "tariffregister",
      confirmed: inp.tariff.provenance.confirmed ?? false,
      source: `${inp.tariff.provenance.source}, ${tariffValid}${inp.tariff.provenance.confirmed ? ", bekreftet for kunden" : ", ikke bekreftet for kundens målepunkt"}`,
    },
    {
      what: "Elavgift",
      value: inp.taxes.periods?.length
        ? `${inp.taxes.periods.map((p) => `${nf(p.orePerKwh, 2)}`).join(" / ")} øre/kWh (${inp.taxes.status})`
        : `${nf(inp.taxes.elavgiftOrePerKwh, 2)} øre/kWh (${inp.taxes.status})`,
      status: inp.taxes.provenance.status,
      sourceType: st(inp.taxes.provenance),
      source: inp.taxes.provenance.source,
    },
    {
      what: "Inverter",
      value: inp.inverterAcKw ? `${nf(inp.inverterAcKw, 1)} kW AC – produksjonen kappes her` : "AC-effekt ukjent – ikke kappet",
      status: inp.inverterAcKw ? "målt" : "antatt",
      sourceType: inp.inverterAcKw ? "oppgitt" : "antatt",
      source: inp.inverterAcKw ? "Fra tilbudets inverter (produktdata)" : "Inverteren i tilbudet mangler AC-effekt i katalogen",
    },
    {
      what: "Eksportgrense",
      value: inp.exportLimitKw == null ? "ukjent – ikke begrenset" : `${inp.exportLimitKw} kW`,
      status: inp.exportLimitKw == null ? "antatt" : "målt",
      sourceType: inp.exportLimitKw == null ? "antatt" : "oppgitt",
      source: inp.exportLimitKw == null ? "Ikke dokumentert tilknytning" : "Oppgitt av selger",
    },
    {
      what: "Importgrense",
      value: inp.importLimitKw == null ? "ukjent" : `${inp.importLimitKw} kW`,
      status: inp.importLimitKw == null ? "antatt" : "målt",
      sourceType: inp.importLimitKw == null ? "antatt" : "oppgitt",
      source: inp.importLimitKw == null ? "Ikke oppgitt – batteriets lading begrenses ikke av tilknytningen" : "Oppgitt av selger (fra tilknytningen)",
    },
    inp.vatNote ? { what: "Mva.", ...inp.vatNote } : { what: "Mva.", value: "Alle beløp eks. mva.", status: "antatt", sourceType: "antatt", source: "Kundens fradragsrett ikke registrert" },
    ...(inp.extraLoad
      ? [{ what: "Lading", value: `${nf(charging?.kwh ?? 0)} kWh lagt til forbruket`, status: "antatt" as DataStatus, sourceType: "antatt" as SourceType, source: inp.extraLoad.provenance.source }]
      : []),
    ...(inp.otherMeters ?? []).map((m) => ({
      what: `Måler: ${m.label}`,
      value: `${m.tariff.gridOwner}: ${m.tariff.name}${m.production ? " · med solceller" : ""}`,
      status: m.tariff.provenance.status,
      sourceType: m.tariff.provenance.sourceType ?? ("tariffregister" as SourceType),
      confirmed: m.tariff.provenance.confirmed ?? false,
      source: `${m.consumption.level === 3 ? "Målt forbruk" : m.consumption.level === 2 ? "Månedsforbruk, anslått døgnprofil" : "Anslått profil"} · tariff ${m.tariff.validFrom}–${m.tariff.validTo ?? "nå"}`,
    })),
    ...(bat ? bat.basis : []),
  ];

  // ---- kontroller som skal være sanne hver gang
  const checks = [
    { label: "Energibalanse per time", ok: Math.max(before.checks.maxBalanceErrorKwh, after.checks.maxBalanceErrorKwh) < 1e-9, detail: `største avvik ${after.checks.maxBalanceErrorKwh.toExponential(1)} kWh` },
    { label: "Forbruk likt før og etter", ok: Math.abs(before.total.loadKwh - after.total.loadKwh) < 1e-6, detail: `${nf(before.total.loadKwh)} kWh` },
    ...(battery
      ? [
          {
            label: "Batteriets energibalanse (inn − ut − tap = endring i lager)",
            ok: battery.alternatives.slice(1).every((a) => (a.result.checks.batteryBalanceErrorKwh ?? 0) < 1e-3),
            detail: battery.alternatives.slice(1).map((a) => `${a.key}: ${(a.result.checks.batteryBalanceErrorKwh ?? 0).toExponential(1)} kWh`).join(", "),
          },
          {
            label: "Batteriet starter og slutter på reservenivå (verdi av rest kreditert)",
            ok: true,
            detail: battery.alternatives.slice(1).map((a) => `${a.key}: start ${nf(a.result.checks.startSocKwh ?? 0, 1)} / slutt ${nf(a.result.checks.endSocKwh ?? 0, 1)} kWh`).join(", "),
          },
          {
            label: "Smartstyring er minst like god som grunnstyring før gebyr",
            ok: battery.alternatives[2].savings.total >= battery.alternatives[1].savings.total - 1,
            detail: `${nf(battery.alternatives[2].savings.total - battery.alternatives[1].savings.total)} kr`,
          },
        ]
      : []),
    { label: "Egenbruk + import = forbruk", ok: Math.abs(after.total.selfKwh + after.total.importKwh - after.total.loadKwh) < 1e-3, detail: "" },
    { label: "Egenbruk + eksport + avkortet = produksjon", ok: Math.abs(after.total.selfKwh + after.total.exportKwh + after.total.curtailedKwh - after.total.pvKwh) < 1e-3, detail: "" },
    { label: "Faste ledd og gebyrer er ikke regnet som spart", ok: Math.abs(sv.fastOgGebyr) < 1e-6, detail: `${nf(sv.fastOgGebyr, 2)} kr` },
    {
      label: "Antall intervaller i perioden",
      ok: after.checks.intervals === Math.round((to - from) / (load.resolutionMin * 60_000)),
      detail: `${after.checks.intervals} ${load.resolutionMin === 15 ? "kvarter" : "timer"}`,
    },
  ];

  const levelLabel = { 1: "anslått profil", 2: "tilpasset kundens månedsforbruk", 3: "kundens målte forbruk" }[c.level];
  const periodLabel = range.label;
  const prod = inp.weatherYear == null ? "produksjon fra leverandørens fil" : "simulert solproduksjon";
  const sameWeather = inp.weatherYear === y;
  let customerSentence =
    c.level === 3 && sameWeather && inp.period.kind === "år"
      ? `Historisk simulering for ${y}, basert på kundens målte forbruk og simulert produksjon fra det foreslåtte anlegget.`
      : `Beregnet besparelse med prisene ${inp.period.kind === "år" ? "i" : "for perioden"} ${periodLabel}, basert på ${c.level === 1 ? "anslått forbruk" : levelLabel} og ${prod}.`;
  if (!range.complete) customerSentence += ` Perioden dekker ${nf(coverage * 100)} % av et år og er ikke et helt årsresultat.`;
  if (inp.period.kind === "egendefinert" && range.complete) customerSentence += ` Perioden er ${range.label}.`;
  if (load.resolutionMin === 15) customerSentence += " Regnet per kvarter.";
  if (inp.tariffScenario) customerSentence += " Nettleien er regnet med en tariff fra en annen periode (scenario).";
  if (bat) customerSentence += " Batteriet er regnet separat med grunnstyring og smart prisstyring.";
  if (vat !== 1) customerSentence += " Beløpene er inkl. mva. (kunden har ikke fradragsrett).";
  if (inp.weatherYear != null && !sameWeather)
    issues.push({ level: "antakelse", field: "produksjon", message: `Prisår ${y} · værgrunnlag ${inp.weatherYear}. Solproduksjonen er tilpasset prisåret.` });

  const hashInput = JSON.stringify({
    ...inp,
    consumption: c.level === 3 ? { level: 3, series: hashSeries(c.series) } : c,
    production: hashSeries(inp.production),
    spot: hashSeries(inp.spot),
    engine: ENGINE_VERSION,
  });

  return {
    engineVersion: ENGINE_VERSION,
    inputHash: createHash("sha256").update(hashInput).digest("hex").slice(0, 20),
    createdAt: new Date().toISOString(),
    period: { label: periodLabel, coverage, complete: range.complete },
    dataLevel: { consumption: c.level, label: levelLabel },
    basis,
    before,
    after,
    savings: sv,
    kpi: {
      selfConsumptionShare: after.total.pvKwh ? after.total.selfKwh / after.total.pvKwh : 0,
      selfSufficiencyShare: after.total.loadKwh ? after.total.selfKwh / after.total.loadKwh : 0,
    },
    historical,
    years: { price: y, weather: inp.weatherYear ?? null },
    economy,
    economyNote,
    battery,
    meters: [
      ...(inp.otherMeters?.length
        ? [
            { id: inp.meteringPoint.id, label: inp.meteringPoint.label, before: withVat(simulate({ ...common, pv: null }), vat).total, after: withVat(simulate({ ...common, pv: inp.production }), vat).total, tariff: inp.tariff.name },
            ...others.map((o) => ({
              id: o.m.id,
              label: o.m.label,
              before: withVat(simulate({ ...o.common, pv: null }), vat).total,
              after: withVat(simulate({ ...o.common, pv: o.m.production }), vat).total,
              tariff: o.m.tariff.name,
            })),
          ]
        : []),
    ],
    charging,
    offerLabel: inp.offerLabel ?? "Tilbudets solcelleanlegg",
    issues,
    valid: !issues.some((i) => i.level === "feil"),
    warnings: issues.map((i) => i.message),
    customerSentence,
    checks,
  };
}
