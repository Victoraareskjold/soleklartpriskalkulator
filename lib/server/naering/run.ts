import "server-only";
// Setter sammen datagrunnlaget for en næringsanalyse fra databasen og eksterne kilder,
// kjører motoren og lager kundesammendraget som lagres i price_data ved låsing.
import type postgres from "postgres";
import { asJson, sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { runAnalysis, type AnalysisInput, type AnalysisResult } from "@/lib/naering/analysis";
import { buildPriceSeries, type PriceArea } from "@/lib/naering/prices";
import { alignToYear, parseV53, parseV6, pvSeries, type ParsedPv, type PvgisVersion, type RoofSurface } from "@/lib/naering/pvgis";
import { osloLocalToUtc, fmtLocal, HOUR } from "@/lib/naering/time";
import type { Tariff } from "@/lib/naering/tariff";
import type { BusinessSettings } from "@/lib/naering/settings";
import type { TimeSeries } from "@/lib/naering/types";
import { activeSeries, parseSettings, rowToSeries, toBytes, seriesSum, type AnalysisRow } from "./store";
import { geocode, pvgisReference, spotRows } from "./sources";

/** Siste værår PVGIS-versjonene har (kontroller ved oppdateringer). */
export const PVGIS_LAST_YEAR: Record<PvgisVersion, number> = { v5_3: 2023, v6: 2025 };

export interface RunOptions {
  /** Kalkylens installerte effekt (kWp) */
  kwp: number | null;
  /** Kalkylens sum eks. mva. for solcelleanlegget (kr), når investeringen hentes fra kalkylen */
  investmentNok: number | null;
  /** Hent oppdaterte kildedata i stedet for lagret grunnlag */
  refresh?: boolean;
  /** Forklaring når investeringen ikke kan hentes fra kalkylen */
  investmentNote?: string;
}

/** Kalkylen kan brukes som solcelleinvestering bare når den ikke inneholder batteri. */
export function investmentFromDraft(draft: { battery?: boolean; lines: { productKind?: string }[] }, totalExVatOre: number | null) {
  const hasBattery = Boolean(draft.battery) || draft.lines.some((l) => l.productKind === "batteri");
  if (hasBattery) return { nok: null, note: "Kalkylen inneholder batteri. Investeringen for solcelledelen er derfor uavklart." };
  return { nok: totalExVatOre == null ? null : totalExVatOre / 100, note: undefined };
}

export interface PreparedRun {
  input: AnalysisInput;
  settings: BusinessSettings;
  meta: {
    surfaces: (RoofSurface & { label: string })[];
    pvgis: { version: PvgisVersion; weatherYear: number; keys: string[]; fetchedAt: string[] } | null;
    spot: { area: PriceArea; days: number; fetched: number };
    loadSeriesId: string | null;
    productionSeriesId: string | null;
    tariff: { id: string; name: string; gridOwner: string };
    investmentSource: string;
    notes: string[];
  };
}

const bad = (msg: string) => new HttpError(422, msg, "INCOMPLETE");

async function loadTariff(id: string | null): Promise<Tariff & { dbId: string }> {
  if (!id) throw bad("Velg nettariff for målepunktet (eller registrer satsene manuelt).");
  const [t] = await sql<{ id: string; code: string | null; grid_owner: string; name: string; customer_group: string; valid_from: Date; valid_to: Date | null; definition: Omit<Tariff, "id" | "gridOwner" | "name" | "customerGroup" | "validFrom" | "validTo" | "provenance" | "vat">; source_url: string | null; last_checked: Date; is_manual: boolean }[]>`
    select * from calc.tariffs where id = ${id}`;
  if (!t) throw bad("Fant ikke valgt tariff");
  const d = (x: Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : undefined);
  return {
    ...t.definition,
    notes: t.definition.notes ?? [],
    id: t.code ?? t.id,
    dbId: t.id,
    gridOwner: t.grid_owner,
    name: t.name,
    customerGroup: t.customer_group,
    validFrom: d(t.valid_from)!,
    validTo: d(t.valid_to),
    vat: "eks_mva",
    provenance: {
      status: t.is_manual ? "antatt" : "målt",
      source: t.is_manual ? "Manuelt registrert tariff" : `Tariffregister${t.source_url ? " (tariffark)" : ""}`,
      lastChecked: d(t.last_checked)!,
      url: t.source_url ?? undefined,
    },
  };
}

function periodBounds(s: BusinessSettings) {
  const y = s.period.year;
  const from = osloLocalToUtc(y, 1, 1, 0)[0];
  const to = s.period.kind === "år" ? osloLocalToUtc(y + 1, 1, 1, 0)[0] : osloLocalToUtc(y, s.period.toMonth, s.period.toDay, 0)[0] + 24 * HOUR;
  const z = (n: number) => String(n).padStart(2, "0");
  const lastDay = s.period.kind === "år" ? `${y}-12-31` : `${y}-${z(s.period.toMonth)}-${z(s.period.toDay)}`;
  return { from, to, firstDay: `${y}-01-01`, lastDay };
}

function covers(series: TimeSeries, from: number, to: number) {
  const end = series.startUtc + series.values.length * series.resolutionMin * 60_000;
  return series.startUtc <= from && end >= to;
}

async function production(s: BusinessSettings, opts: RunOptions, analysisId: string, lat: number, lon: number, notes: string[]) {
  const y = s.period.year;
  const mp = s.meteringPoint.id;

  // Fordel kWp på flatene: faste kWp først, resten etter panelantall
  let surfaces = s.production.surfaces;
  if (!surfaces.length) {
    surfaces = [{ id: "standard", label: "Antatt takflate", panels: null, kwp: null, tiltDeg: 15, azimuthDeg: 180 }];
    notes.push("Ingen takflater registrert: antatt én flate mot sør med 15° helning.");
  }
  const fixed = surfaces.reduce((a, x) => a + (x.kwp ?? 0), 0);
  const open = surfaces.filter((x) => x.kwp == null);
  const rest = opts.kwp != null ? Math.max(0, opts.kwp - fixed) : null;
  if (open.length && rest == null) throw bad("Mangler kWp: legg inn paneler i kalkylen eller kWp per takflate.");
  const panelSum = open.reduce((a, x) => a + (x.panels ?? 0), 0);
  const used = surfaces.map((x) => ({
    id: x.id,
    label: x.label || x.id,
    kwp: x.kwp ?? (panelSum > 0 ? (rest! * (x.panels ?? 0)) / panelSum : rest! / open.length),
    tiltDeg: x.tiltDeg,
    azimuthDeg: x.azimuthDeg,
    lossPct: s.production.lossPct,
    meteringPointId: mp,
  }));

  if (s.production.source === "fil") {
    const row = await activeSeries(analysisId, mp, "produksjon");
    if (!row) throw bad("Produksjon fra fil er valgt, men ingen produksjonsfil er importert.");
    return { series: rowToSeries(row), surfaces: used, pvgis: null, seriesId: row.id };
  }

  // PVGIS: versjon og værår
  const wanted = s.production.weatherYear ?? y;
  let version: PvgisVersion = s.production.pvgisVersion === "auto" ? (wanted > PVGIS_LAST_YEAR.v5_3 ? "v6" : "v5_3") : s.production.pvgisVersion;
  let weatherYear = Math.min(wanted, PVGIS_LAST_YEAR[version]);

  const fetchAll = async (v: PvgisVersion, wy: number) => {
    const out: { surface: RoofSurface; parsed: ParsedPv; key: string; at: string }[] = [];
    for (const surf of used) {
      if (surf.kwp <= 0) continue;
      const ref = await pvgisReference(v, lat, lon, surf, wy, opts.refresh);
      let parsed: ParsedPv;
      try {
        parsed = v === "v5_3" ? parseV53(ref.response) : parseV6(ref.response, osloLocalToUtc(wy, 1, 1, 0)[0]);
      } catch (e) {
        throw new HttpError(502, `Svaret fra PVGIS kunne ikke tolkes: ${(e as Error).message}`, "SOURCE_FORMAT");
      }
      out.push({ surface: surf, parsed: { ...parsed, kwh: parsed.kwh.map((k) => k * surf.kwp) }, key: ref.key, at: ref.fetchedAt });
    }
    if (!out.length) throw bad("Anlegget har 0 kWp.");
    alignToYear(out[0].parsed, wy, y); // kaster hvis serien ikke dekker året
    return out;
  };
  let fetched: Awaited<ReturnType<typeof fetchAll>>;
  try {
    fetched = await fetchAll(version, weatherYear);
  } catch (e) {
    if (version !== "v6" || s.production.pvgisVersion !== "auto") throw e;
    notes.push(`PVGIS 6 kunne ikke brukes (${(e as Error).message}). Brukte PVGIS 5.3 med værår ${PVGIS_LAST_YEAR.v5_3}.`);
    version = "v5_3";
    weatherYear = PVGIS_LAST_YEAR.v5_3;
    fetched = await fetchAll(version, weatherYear);
  }
  if (weatherYear !== y) notes.push(`Solproduksjonen bygger på værår ${weatherYear}, lagt på kalenderen for ${y} (tilpasset).`);
  return {
    series: pvSeries(fetched, weatherYear, y, version),
    surfaces: used,
    pvgis: { version, weatherYear, keys: fetched.map((f) => f.key), fetchedAt: fetched.map((f) => f.at) },
    seriesId: null,
  };
}

export async function prepareRun(analysis: AnalysisRow, opts: RunOptions): Promise<PreparedRun> {
  const s = parseSettings(analysis.settings);
  const notes: string[] = [];
  const { from, to, firstDay, lastDay } = periodBounds(s);
  if (to > Date.now() + HOUR) throw bad("Perioden er ikke over ennå. Velg «hittil i år» med en dato bak oss, eller et tidligere år.");

  // Sted og prisområde
  let { lat, lon, priceArea } = s.location;
  if ((lat == null || lon == null || !priceArea) && s.location.address) {
    const g = await geocode(s.location.address);
    lat ??= g.lat;
    lon ??= g.lon;
    if (!priceArea && g.priceArea) {
      priceArea = g.priceArea;
      notes.push(`Prisområde ${g.priceArea} er foreslått fra adressen (${g.municipality}). Kontroller.`);
    }
  }
  if (lat == null || lon == null) throw bad("Mangler adresse eller koordinater for anlegget.");
  if (!priceArea) throw bad("Velg prisområde (NO1–NO5).");

  const tariff = await loadTariff(s.meteringPoint.tariffId);
  const prod = await production(s, opts, analysis.id, lat, lon, notes);

  // Forbruk
  let consumption: AnalysisInput["consumption"];
  let loadSeriesId: string | null = null;
  const c = s.consumption;
  if (c.level === 3) {
    const row = await activeSeries(analysis.id, s.meteringPoint.id, "forbruk");
    if (!row) throw bad("Målt forbruk er valgt, men ingen forbruksfil er importert.");
    const series = rowToSeries(row);
    if (!covers(series, from, to))
      throw bad(`Målt forbruk dekker ${row.provenance.period?.from ?? "?"} – ${row.provenance.period?.to ?? "?"}, ikke analyseperioden. Velg et år filen dekker.`);
    if (series.resolutionMin !== 60) throw bad("Kvartersdata summeres til timer i neste versjon. Last opp timesverdier inntil videre.");
    consumption = { level: 3, series, report: row.quality ?? { intervals: series.values.length, expectedIntervals: series.values.length, resolutionMin: 60, firstLocal: "", lastLocal: "", sumKwh: seriesSum(series.values), missing: 0, duplicates: 0, estimated: 0, issues: [] } };
    loadSeriesId = row.id;
  } else if (c.level === 2) {
    if (!c.monthlyKwh) throw bad("Oppgi forbruk for alle tolv måneder.");
    consumption = { level: 2, type: s.businessType, monthlyKwh: c.monthlyKwh, openHours: s.openHours ?? undefined };
  } else {
    if (!c.annualKwh) throw bad("Oppgi årsforbruk (eller et anslag).");
    consumption = { level: 1, type: s.businessType, annualKwh: c.annualKwh, openHours: s.openHours ?? undefined };
  }
  if (!covers(prod.series, from, to)) throw bad("Produksjonsserien dekker ikke analyseperioden.");

  // Spotpriser
  const spot = await spotRows(priceArea, firstDay, lastDay, opts.refresh);
  if (spot.unavailable.length)
    throw bad(`Mangler spotpriser for ${spot.unavailable.length} døgn (f.eks. ${spot.unavailable.slice(0, 2).join(", ")}). Prøv igjen senere.`);
  const prices = buildPriceSeries(spot.rows, priceArea);
  notes.push(...prices.notes);

  // Investering
  const inv = s.economy.investment;
  const investmentNok = inv.source === "manuell" ? inv.nok : inv.source === "kalkyle" ? opts.investmentNok : null;
  if (inv.source === "kalkyle" && opts.investmentNok == null)
    notes.push(opts.investmentNote ?? "Kalkylen har ingen sum ennå – investeringen vises som uavklart.");

  const el = s.meteringPoint.elavgift;
  if (el.orePerKwh == null) notes.push("Elavgift er ikke oppgitt og er regnet som 0. Besparelsen er da undervurdert.");
  const mp = s.meteringPoint;

  const input: AnalysisInput = {
    project: { name: "", address: s.location.address, priceArea, businessType: s.businessType },
    meteringPoint: { id: mp.id, label: mp.label },
    period: s.period,
    consumption,
    production: prod.series,
    spot: prices.series,
    tariff,
    taxes: {
      elavgiftOrePerKwh: el.orePerKwh ?? 0,
      status: el.taxStatus,
      provenance: { status: el.orePerKwh == null ? "antatt" : el.status, source: el.orePerKwh == null ? "Ikke oppgitt – regnet som 0" : "Registrert av selger" },
    },
    buy: {
      type: "spot",
      markupOrePerKwh: mp.buy.markupOrePerKwh,
      monthlyFeeNok: mp.buy.monthlyFeeNok,
      provenance: { status: mp.buy.status, source: mp.buy.status === "antatt" ? "Antatt (kundens avtale ikke registrert)" : "Kundens avtale" },
    },
    sell: {
      type: "spot",
      deductionOrePerKwh: mp.sell.deductionOrePerKwh,
      provenance: { status: mp.sell.status, source: mp.sell.status === "antatt" ? "Antatt (ingen salgsavtale registrert)" : "Kundens salgsavtale" },
    },
    exportLimitKw: mp.exportLimitKw,
    economy: {
      investmentNok,
      years: s.economy.years,
      discountRate: s.economy.discountRatePct / 100,
      growth: {
        kraft: s.economy.growth.kraftPct / 100,
        nettleie: s.economy.growth.nettleiePct / 100,
        avgift: s.economy.growth.avgiftPct / 100,
        drift: s.economy.growth.driftPct / 100,
      },
      degradationPerYear: s.economy.degradationPct / 100,
      opex: s.economy.opex,
      replacements: s.economy.replacements,
    },
    scenarios: s.scenarios.map((x) => ({ name: x.name, kraftGrowth: x.kraftGrowthPct / 100 })),
  };

  return {
    input,
    settings: s,
    meta: {
      surfaces: prod.surfaces,
      pvgis: prod.pvgis,
      spot: { area: priceArea, days: Math.round((to - from) / HOUR / 24), fetched: spot.fetched },
      loadSeriesId,
      productionSeriesId: prod.seriesId,
      tariff: { id: tariff.dbId, name: tariff.name, gridOwner: tariff.gridOwner },
      investmentSource: inv.source,
      notes,
    },
  };
}

export function execute(p: PreparedRun) {
  const result = runAnalysis(p.input);
  result.warnings.push(...p.meta.notes);
  return result;
}

// ---------------------------------------------------------------- kundesammendrag (price_data.businessAnalysis)

const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Det tilbudssiden trenger. Ingen rådata, interne kommentarer eller filer. */
export function customerSummary(res: AnalysisResult, p: PreparedRun, runId: string | null) {
  const t = (e: AnalysisResult["before"]) => ({
    loadKwh: r0(e.total.loadKwh),
    pvKwh: r0(e.total.pvKwh),
    selfKwh: r0(e.total.selfKwh),
    importKwh: r0(e.total.importKwh),
    exportKwh: r0(e.total.exportKwh),
    curtailedKwh: r0(e.total.curtailedKwh),
    cost: Object.fromEntries(Object.entries(e.total.cost).map(([k, v]) => [k, r0(v)])),
  });
  return {
    status: "beregnet" as const,
    runId,
    engineVersion: res.engineVersion,
    inputHash: res.inputHash,
    calculatedAt: res.createdAt,
    period: res.period,
    dataLevel: res.dataLevel,
    customerSentence: res.customerSentence,
    system: {
      kwp: r2(p.meta.surfaces.reduce((a, x) => a + x.kwp, 0)),
      surfaces: p.meta.surfaces.map((x) => ({ label: x.label, kwp: r2(x.kwp), tiltDeg: x.tiltDeg, azimuthDeg: x.azimuthDeg })),
    },
    investmentNok: p.input.economy.investmentNok,
    investmentSource: p.meta.investmentSource,
    kpi: { selfConsumptionShare: r2(res.kpi.selfConsumptionShare), selfSufficiencyShare: r2(res.kpi.selfSufficiencyShare) },
    before: t(res.before),
    after: t(res.after),
    savings: Object.fromEntries(Object.entries(res.savings).map(([k, v]) => [k, r0(v)])),
    months: res.before.months.map((b, i) => {
      const a = res.after.months[i];
      return {
        month: b.month,
        loadKwh: r0(b.loadKwh),
        pvKwh: r0(a.pvKwh),
        selfKwh: r0(a.selfKwh),
        importBeforeKwh: r0(b.importKwh),
        importAfterKwh: r0(a.importKwh),
        exportKwh: r0(a.exportKwh),
        peakBeforeKw: r2(b.peakKw),
        peakAfterKw: r2(a.peakKw),
        costBefore: r0(b.cost.netto),
        costAfter: r0(a.cost.netto),
      };
    }),
    economy:
      res.economy?.map((e) => ({
        name: e.name,
        kraftGrowth: e.kraftGrowth,
        npv: e.result.npv == null ? null : r0(e.result.npv),
        pvOfOperations: r0(e.result.pvOfOperations),
        paybackYears: e.result.paybackYears == null ? null : r2(e.result.paybackYears),
        discountedPaybackYears: e.result.discountedPaybackYears == null ? null : r2(e.result.discountedPaybackYears),
        irr: e.result.irr == null ? null : r2(e.result.irr * 100) / 100,
        irrNote: e.result.irrNote ?? null,
        firstYearNet: r0(e.result.firstYearNet),
        rows: e.result.rows.map((x) => ({
          year: x.year,
          netto: r0(x.netto),
          akkumulert: x.akkumulert == null ? null : r0(x.akkumulert),
          savedKraft: r0(x.savedKraft),
          savedNettleie: r0(x.savedNettleie),
          savedAvgift: r0(x.savedAvgift),
          salg: r0(x.salg),
          drift: r0(x.drift),
          utskifting: r0(x.utskifting),
        })),
      })) ?? null,
    economyNote: res.economyNote ?? null,
    assumptions: {
      years: p.settings.economy.years,
      discountRatePct: p.settings.economy.discountRatePct,
      growth: p.settings.economy.growth,
      degradationPct: p.settings.economy.degradationPct,
      opex: p.settings.economy.opex,
      replacements: p.settings.economy.replacements,
      vat: "Alle beløp eks. mva.",
      beforeTax: "Prosjektøkonomi før skatt og finansiering.",
    },
    basis: res.basis,
    warnings: res.warnings,
    checks: res.checks.map((c) => ({ label: c.label, ok: c.ok })),
  };
}

export type CustomerSummary = ReturnType<typeof customerSummary>;

// ---------------------------------------------------------------- låsing

/**
 * Lagrer en låst kjøring knyttet til en tilbudsversjon. PVGIS- og prisgrunnlaget kopieres til
 * låste serier, så senere oppdateringer av mellomlageret aldri endrer et sendt tilbud.
 */
export async function lockRun(
  tx: postgres.TransactionSql,
  analysisId: string,
  quoteVersionId: string,
  estimateId: string | null,
  p: PreparedRun,
  res: AnalysisResult,
  userId: string,
) {
  const save = async (series: TimeSeries) => {
    const [row] = await tx<{ id: string }[]>`
      insert into calc.business_series (analysis_id, metering_point_id, kind, origin, status, resolution_min, start_utc, intervals, sum_kwh, values_f64, provenance, active, created_by)
      values (${analysisId}, ${p.input.meteringPoint.id}, ${series.kind}, 'låst', ${series.provenance.status}, ${series.resolutionMin},
              ${new Date(series.startUtc)}, ${series.values.length}, ${series.kind === "pris" ? 0 : seriesSum(series.values)},
              ${toBytes(series.values)}, ${asJson(series.provenance)}, false, ${userId})
      returning id`;
    return row.id;
  };
  const productionId = p.meta.productionSeriesId ?? (await save(p.input.production));
  const spotId = await save(p.input.spot);
  const summary = customerSummary(res, p, null);
  const [run] = await tx<{ id: string }[]>`
    insert into calc.business_runs (analysis_id, quote_version_id, estimate_id, engine_version, input_hash, input_snapshot, result, locked_at, created_by)
    values (${analysisId}, ${quoteVersionId}, ${estimateId}, ${res.engineVersion}, ${res.inputHash},
      ${asJson({ settings: p.settings, meta: p.meta, series: { load: p.meta.loadSeriesId, production: productionId, spot: spotId } })},
      ${asJson(summary)}, now(), ${userId})
    returning id`;
  return { ...summary, runId: run.id };
}

export function notCalculated(reason: string) {
  return { status: "ikke beregnet" as const, reason, at: fmtLocal(Date.now()) };
}
