// Setter sammen én analyse: datagrunnlag → før/etter → levetidsøkonomi → forklaringer.
// Resultatet inneholder alt som skal låses med tilbudet: grunnlag, versjon og hash.

import { createHash } from "node:crypto";
import type { AnalysisIssue, DataStatus, QualityReport, SourceType, TimeSeries } from "./types";
import type { BuyAgreement, SellAgreement, Taxes, Tariff } from "./tariff";
import { ENGINE_VERSION, simulate, savings, type EngineInput, type EngineResult } from "./engine";
import { lifetime, type EconomyInput, type EconomyResult } from "./economy";
import { standardProfile, type BusinessType } from "./profiles";
import { HOUR, hoursInYear, osloLocalToUtc } from "./time";

export type ConsumptionBasis =
  | { level: 1; type: BusinessType; annualKwh: number; openHours?: [number, number] }
  | { level: 2; type: BusinessType; monthlyKwh: number[]; openHours?: [number, number] }
  | { level: 3; series: TimeSeries; report: QualityReport };

export interface AnalysisInput {
  project: { name: string; address: string; priceArea: string; businessType: BusinessType; isExample?: boolean };
  meteringPoint: { id: string; label: string };
  period: { kind: "år"; year: number } | { kind: "hittil"; year: number; toMonth: number; toDay: number };
  consumption: ConsumptionBasis;
  production: TimeSeries;
  spot: TimeSeries;
  tariff: Tariff;
  taxes: Taxes;
  buy: BuyAgreement;
  sell: SellAgreement;
  exportLimitKw: number | null;
  /** Invertere(nes) samlede AC-effekt fra tilbudet. null = ukjent (produksjonen kappes ikke). */
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
  /** Avvik: feil gjør resultatet ubrukelig i tilbud, advarsler må vurderes, antakelser er synlige anslag */
  issues: AnalysisIssue[];
  valid: boolean;
  warnings: string[];
  customerSentence: string;
  checks: { label: string; ok: boolean; detail: string }[];
}

const nf = (x: number, d = 0) => x.toLocaleString("nb-NO", { maximumFractionDigits: d, minimumFractionDigits: d });

function hashSeries(s: TimeSeries) {
  return createHash("sha256").update(new Uint8Array(s.values.buffer)).digest("hex").slice(0, 16);
}

export function runAnalysis(inp: AnalysisInput): AnalysisResult {
  const issues: AnalysisIssue[] = [...(inp.issues ?? [])];
  const y = inp.period.year;
  const from = osloLocalToUtc(y, 1, 1, 0)[0];
  const to =
    inp.period.kind === "år"
      ? osloLocalToUtc(y + 1, 1, 1, 0)[0]
      : osloLocalToUtc(y, inp.period.toMonth, inp.period.toDay, 0)[0] + 24 * HOUR;
  const coverage = (to - from) / HOUR / hoursInYear(y);

  // ---- forbruk etter datanivå
  let load: TimeSeries;
  const c = inp.consumption;
  if (c.level === 3) {
    load = c.series;
    for (const i of c.report.issues)
      if (i.level !== "info") issues.push({ level: i.level === "feil" ? "feil" : "advarsel", field: "forbruk", message: `Forbruksdata: ${i.message}` });
  } else
    load = standardProfile({
      type: c.type,
      year: y,
      annualKwh: c.level === 1 ? c.annualKwh : 0,
      monthlyKwh: c.level === 2 ? c.monthlyKwh : undefined,
      openHours: c.openHours,
    });

  const common = {
    load, spot: inp.spot, buy: inp.buy, sell: inp.sell, tariff: inp.tariff, taxes: inp.taxes,
    exportLimitKw: inp.exportLimitKw, inverterAcKw: inp.inverterAcKw ?? null, fromUtc: from, toUtc: to,
  };
  const beforeIn: EngineInput = { ...common, pv: null };
  const afterIn: EngineInput = { ...common, pv: inp.production };
  const before = simulate(beforeIn);
  const after = simulate(afterIn);
  const sv = savings(before, after);

  if (after.total.clippedKwh > 0.5)
    issues.push({
      level: "antakelse",
      field: "produksjon",
      message: `Inverteren (${nf(inp.inverterAcKw ?? 0, 1)} kW AC) kapper ${nf(after.total.clippedKwh)} kWh av solproduksjonen i perioden.`,
    });

  // ---- historisk år: energifordel minus tiltakets løpende kostnader (uten prisvekst)
  const share = inp.period.kind === "år" ? 1 : coverage;
  const opexItems = inp.economy.opex.map((o) => ({ name: o.name, nok: o.nokPerYear * share }));
  const opex = opexItems.reduce((a, o) => a + o.nok, 0);
  const historical = { energySaving: sv.total, opex, net: sv.total - opex, opexItems };

  // ---- økonomi (bare for helt år – delår skal ikke ganges opp)
  let economy: AnalysisResult["economy"] = null;
  let economyNote: string | undefined;
  if (inp.period.kind === "år") {
    economy = inp.scenarios.map((s) => ({
      name: s.name,
      kraftGrowth: s.kraftGrowth,
      result: lifetime({ before: beforeIn, after: afterIn }, { ...inp.economy, growth: { ...inp.economy.growth, kraft: s.kraftGrowth } }),
    }));
    if (inp.economy.investmentNok == null)
      economyNote = "Investeringen for solcelledelen er ikke avklart. Nåverdi og tilbakebetaling vises ikke; i stedet vises høyeste investering som gir positiv nåverdi.";
  } else economyNote = "Hittil i år: levetidsøkonomi beregnes bare fra et helt år. Delåret vises som det er, ikke oppskalert.";

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
      source: `${inp.production.provenance.source}. ${inp.production.provenance.note ?? ""}`.trim(),
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
    { what: "Mva.", value: "Alle beløp eks. mva.", status: "antatt", sourceType: "antatt", source: "Kundens fradragsrett ikke registrert" },
  ];

  // ---- kontroller som skal være sanne hver gang
  const checks = [
    { label: "Energibalanse per time", ok: Math.max(before.checks.maxBalanceErrorKwh, after.checks.maxBalanceErrorKwh) < 1e-9, detail: `største avvik ${after.checks.maxBalanceErrorKwh.toExponential(1)} kWh` },
    { label: "Forbruk likt før og etter", ok: Math.abs(before.total.loadKwh - after.total.loadKwh) < 1e-6, detail: `${nf(before.total.loadKwh)} kWh` },
    { label: "Egenbruk + import = forbruk", ok: Math.abs(after.total.selfKwh + after.total.importKwh - after.total.loadKwh) < 1e-3, detail: "" },
    { label: "Egenbruk + eksport + avkortet = produksjon", ok: Math.abs(after.total.selfKwh + after.total.exportKwh + after.total.curtailedKwh - after.total.pvKwh) < 1e-3, detail: "" },
    { label: "Faste ledd og gebyrer er ikke regnet som spart", ok: Math.abs(sv.fastOgGebyr) < 1e-6, detail: `${nf(sv.fastOgGebyr, 2)} kr` },
    { label: "Antall timer i perioden", ok: after.checks.intervals === Math.round((to - from) / HOUR), detail: `${after.checks.intervals} timer` },
  ];

  const levelLabel = { 1: "anslått profil", 2: "tilpasset kundens månedsforbruk", 3: "kundens målte forbruk" }[c.level];
  const periodLabel = inp.period.kind === "år" ? `${y}` : `1.1.–${inp.period.toDay}.${inp.period.toMonth}.${y}`;
  const prod = inp.weatherYear == null ? "produksjon fra leverandørens fil" : "simulert solproduksjon";
  const sameWeather = inp.weatherYear === y;
  let customerSentence =
    c.level === 3 && sameWeather && inp.period.kind === "år"
      ? `Historisk simulering for ${y}, basert på kundens målte forbruk og simulert produksjon fra det foreslåtte anlegget.`
      : `Beregnet besparelse med prisene ${inp.period.kind === "år" ? "i" : "for perioden"} ${periodLabel}, basert på ${c.level === 1 ? "anslått forbruk" : levelLabel} og ${prod}.`;
  if (inp.period.kind === "hittil") customerSentence += ` Perioden dekker ${nf(coverage * 100)} % av året og er ikke et helt årsresultat.`;
  if (inp.tariffScenario) customerSentence += " Nettleien er regnet med en tariff fra en annen periode (scenario).";
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
    period: { label: periodLabel, coverage, complete: inp.period.kind === "år" },
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
    issues,
    valid: !issues.some((i) => i.level === "feil"),
    warnings: issues.map((i) => i.message),
    customerSentence,
    checks,
  };
}
