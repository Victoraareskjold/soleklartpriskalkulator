import "server-only";
// Setter sammen datagrunnlaget for en næringsanalyse fra databasen og eksterne kilder,
// kjører motoren og lager kundesammendraget som lagres i price_data ved låsing.
//
// Avvik samles som issues (feil / advarsel / antakelse) med feltgruppe, så dashboardet kan vise dem
// ved feltet og i oppsummeringen. Feil = grunnlaget er ugyldig eller motstridende, og analysen
// tas ikke med i et tilbud før det er rettet. Antakelser er en normal, tillatt arbeidsflyt.
import type postgres from "postgres";
import { asJson, sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { runAnalysis, type AnalysisInput, type AnalysisResult } from "@/lib/naering/analysis";
import { buildPriceSeries, type PriceArea } from "@/lib/naering/prices";
import { alignToYear, parseV53, parseV6, pvSeries, type ParsedPv, type PvgisVersion, type RoofSurface } from "@/lib/naering/pvgis";
import { osloLocalToUtc, fmtLocal, HOUR } from "@/lib/naering/time";
import { tariffCovers, type Tariff } from "@/lib/naering/tariff";
import { taxPeriods } from "@/lib/naering/taxes";
import type { BusinessSettings } from "@/lib/naering/settings";
import type { AnalysisIssue, TimeSeries } from "@/lib/naering/types";
import type { CalculationResult } from "@/lib/engine";
import type { Settings } from "@/lib/server/settings";
import { activeSeries, parseSettings, rowToSeries, toBytes, seriesSum, type AnalysisRow } from "./store";
import { geocode, pvgisReference, spotRows } from "./sources";

/** Siste værår PVGIS-versjonene har (kontroller ved oppdateringer). */
export const PVGIS_LAST_YEAR: Record<PvgisVersion, number> = { v5_3: 2023, v6: 2025 };

/** Det analysen trenger fra tilbudet (kalkylen). Regnes alltid på serveren fra utkastet. */
export interface QuoteContext {
  kwp: number | null;
  /** Solcelleinvestering eks. mva. (kr), null = uavklart */
  investmentNok: number | null;
  investmentNote?: string;
  /** Invertere(nes) samlede AC-effekt (kW), null = ukjent */
  inverterAcKw: number | null;
  /** Inverternes kundepris eks. mva. i tilbudet (kr), null = ingen inverter i tilbudet */
  inverterNok: number | null;
  inverterNames: string[];
  /** Batteri som tillegg kunden kan velge i tilbudet */
  batteryOffered: boolean;
  /** Fra Beregningsregler */
  replacementYear: number;
  replacementFactor: number;
  maintenancePerYear: number;
}

export interface RunOptions {
  quote: QuoteContext;
  /** Hent oppdaterte kildedata i stedet for lagret grunnlag */
  refresh?: boolean;
}

/**
 * Leser tilbudet: kWp, investering (bare når kalkylen ikke har batteri), inverterens AC-effekt og
 * kundepris, og standardverdier fra Beregningsregler. lines/meta kommer fra buildEngineInput.
 */
export function quoteContext(
  built: { kwp: number; input: { lines: { productKind?: string; quantity: string | number; meta?: Record<string, unknown> }[] } },
  result: CalculationResult,
  settings: Settings,
  draft: { battery?: boolean; batteryOffer?: { enabled?: boolean } | null },
): QuoteContext {
  const kinds = built.input.lines.map((l) => l.productKind);
  const hasBattery = Boolean(draft.battery) || kinds.includes("batteri");
  const share = result.totals.subtotal > 0 ? result.totals.totalExVat / result.totals.subtotal : 1;
  let ac = 0;
  let acUnknown = false;
  let inverterNok = 0;
  const names: string[] = [];
  built.input.lines.forEach((l, i) => {
    if (l.productKind !== "inverter") return;
    const qty = Number(String(l.quantity).replace(",", ".")) || 0;
    const acKw = Number(l.meta?.acKw);
    if (acKw > 0) ac += acKw * qty;
    else acUnknown = true;
    inverterNok += ((result.lines[i]?.sale ?? 0) * share) / 100;
    names.push(String(l.meta?.productName ?? "inverter"));
  });
  const a = settings.offerAssumptions ?? {};
  return {
    kwp: built.kwp > 0 ? built.kwp : null,
    investmentNok: hasBattery ? null : result.totals.totalExVat / 100,
    investmentNote: hasBattery ? "Tilbudet inneholder batteri. Investeringen for solcelledelen er derfor uavklart." : undefined,
    inverterAcKw: names.length && !acUnknown ? ac : null,
    inverterNok: names.length ? inverterNok : null,
    inverterNames: names,
    batteryOffered: draft.batteryOffer?.enabled === true,
    replacementYear: Number(a.replacementYear) || 15,
    replacementFactor: Number(a.replacementFactor) || 1.4,
    maintenancePerYear: Number(a.maintenancePerYear) || 0,
  };
}

export interface PreparedRun {
  input: AnalysisInput;
  settings: BusinessSettings;
  meta: {
    surfaces: (RoofSurface & { label: string; assumed?: boolean })[];
    pvgis: { version: PvgisVersion; weatherYear: number; keys: string[]; fetchedAt: string[]; fallback?: string } | null;
    spot: { area: PriceArea; days: number; fetched: number };
    loadSeriesId: string | null;
    productionSeriesId: string | null;
    /** Hele tariffen slik den ble brukt (bevares i låste kjøringer selv om registeret endres) */
    tariff: { id: string; name: string; gridOwner: string; validFrom: string; validTo?: string; definition: Omit<Tariff, "provenance"> };
    investmentSource: string;
    quote: QuoteContext;
    issues: AnalysisIssue[];
    notes: string[];
  };
}

const bad = (msg: string) => new HttpError(422, msg, "INCOMPLETE");

interface TariffRow {
  id: string;
  code: string | null;
  grid_owner: string;
  name: string;
  customer_group: string;
  valid_from: Date;
  valid_to: Date | null;
  definition: Omit<Tariff, "id" | "gridOwner" | "name" | "customerGroup" | "validFrom" | "validTo" | "provenance" | "vat">;
  source_url: string | null;
  last_checked: Date;
  is_manual: boolean;
  archived_at: Date | null;
}

async function loadTariff(id: string | null, confirmed: boolean): Promise<Tariff & { dbId: string; archived: boolean }> {
  if (!id) throw bad("Velg nettariff for målepunktet, eller legg inn satsene fra kundens nettleiefaktura.");
  const [t] = await sql<TariffRow[]>`select * from calc.tariffs where id = ${id}`;
  if (!t) throw bad("Fant ikke valgt tariff. Velg tariff på nytt.");
  const d = (x: Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : undefined);
  return {
    ...t.definition,
    notes: t.definition.notes ?? [],
    id: t.code ?? t.id,
    dbId: t.id,
    archived: t.archived_at != null,
    gridOwner: t.grid_owner,
    name: t.name,
    customerGroup: t.customer_group,
    validFrom: d(t.valid_from)!,
    validTo: d(t.valid_to),
    vat: "eks_mva",
    provenance: {
      status: confirmed ? "målt" : "antatt",
      sourceType: t.is_manual ? "oppgitt" : "tariffregister",
      confirmed,
      source: t.is_manual
        ? "Manuelt registrert tariff"
        : `Fra tariffregister (manuelt vedlikeholdt, sist kontrollert ${d(t.last_checked)})`,
      lastChecked: d(t.last_checked)!,
      url: t.source_url ?? undefined,
    },
  };
}

function periodBounds(s: BusinessSettings) {
  const y = s.period.year;
  const from = osloLocalToUtc(y, 1, 1, 0)[0];
  const to = s.period.kind === "år" ? osloLocalToUtc(y + 1, 1, 1, 0)[0] : osloLocalToUtc(y, s.period.toMonth, s.period.toDay, 0)[0] + 24 * HOUR;
  if (!Number.isFinite(to)) throw bad("Ugyldig sluttdato for perioden.");
  const z = (n: number) => String(n).padStart(2, "0");
  const lastDay = s.period.kind === "år" ? `${y}-12-31` : `${y}-${z(s.period.toMonth)}-${z(s.period.toDay)}`;
  return { from, to, firstDay: `${y}-01-01`, lastDay };
}

function covers(series: TimeSeries, from: number, to: number) {
  const end = series.startUtc + series.values.length * series.resolutionMin * 60_000;
  return series.startUtc <= from && end >= to;
}

async function production(s: BusinessSettings, opts: RunOptions, analysisId: string, lat: number, lon: number, issues: AnalysisIssue[]) {
  const y = s.period.year;
  const mp = s.meteringPoint.id;
  const kwp = opts.quote.kwp;

  // Takflater: fra tilbudet/solkartet, ellers en synlig eksempelrad
  let surfaces = s.production.surfaces;
  if (!surfaces.length) {
    surfaces = [{ id: "eksempel", label: "Eksempel: én flate mot sør, 15°", panels: null, kwp: null, tiltDeg: 15, azimuthDeg: 180, assumed: true }];
  }
  if (surfaces.some((x) => x.assumed))
    issues.push({ level: "antakelse", field: "takflater", message: "Takflaten er et eksempel (sør, 15°), ikke hentet fra tilbudet. Kontroller retning og helning." });
  const fixed = surfaces.reduce((a, x) => a + (x.kwp ?? 0), 0);
  const open = surfaces.filter((x) => x.kwp == null);
  const rest = kwp != null ? Math.max(0, kwp - fixed) : null;
  if (open.length && rest == null) throw bad("Mangler kWp: legg inn paneler i kalkylen eller kWp per takflate.");
  if (kwp != null && fixed > kwp * 1.001 && !open.length)
    issues.push({ level: "advarsel", field: "takflater", message: `Takflatene har til sammen ${fixed.toFixed(1)} kWp, men tilbudet har ${kwp.toFixed(1)} kWp.` });
  const panelSum = open.reduce((a, x) => a + (x.panels ?? 0), 0);
  const used = surfaces.map((x) => ({
    id: x.id,
    label: x.label || x.id,
    assumed: x.assumed,
    kwp: x.kwp ?? (panelSum > 0 ? (rest! * (x.panels ?? 0)) / panelSum : rest! / open.length),
    tiltDeg: x.tiltDeg,
    azimuthDeg: x.azimuthDeg,
    lossPct: s.production.lossPct,
    meteringPointId: mp,
  }));

  if (s.production.source === "fil") {
    const row = await activeSeries(analysisId, mp, "produksjon");
    if (!row) throw bad("Produksjon fra fil er valgt, men ingen produksjonsfil er importert.");
    return { series: rowToSeries(row), surfaces: used, pvgis: null, seriesId: row.id, weatherYear: null };
  }

  // PVGIS: versjon og værår. Værår = prisåret når PVGIS har det.
  const wanted = s.production.weatherYear ?? y;
  let version: PvgisVersion = s.production.pvgisVersion === "auto" ? (wanted > PVGIS_LAST_YEAR.v5_3 ? "v6" : "v5_3") : s.production.pvgisVersion;
  let weatherYear = Math.min(wanted, PVGIS_LAST_YEAR[version]);
  let fallback: string | undefined;

  const fetchAll = async (v: PvgisVersion, wy: number) => {
    const out: { surface: RoofSurface; parsed: ParsedPv; key: string; at: string }[] = [];
    for (const surf of used) {
      if (surf.kwp <= 0) continue;
      const ref = await pvgisReference(v, lat, lon, surf, wy, opts.refresh);
      let parsed: ParsedPv;
      try {
        parsed = v === "v5_3" ? parseV53(ref.response) : parseV6(ref.response, osloLocalToUtc(wy, 1, 1, 0)[0], (osloLocalToUtc(wy + 1, 1, 1, 0)[0] - osloLocalToUtc(wy, 1, 1, 0)[0]) / HOUR);
      } catch (e) {
        throw new HttpError(502, `Svaret fra PVGIS ${v.replace("_", ".")} kunne ikke tolkes: ${(e as Error).message}`, "SOURCE_FORMAT");
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
    // Integrasjonsfeil er ikke bevis på at året mangler: vis den tydelig som avvik.
    fallback = (e as Error).message;
    issues.push({
      level: "advarsel",
      field: "produksjon",
      message: `PVGIS 6 kunne ikke brukes (${fallback}). Reserveberegning med PVGIS 5.3 og værår ${PVGIS_LAST_YEAR.v5_3}.`,
    });
    version = "v5_3";
    weatherYear = PVGIS_LAST_YEAR.v5_3;
    fetched = await fetchAll(version, weatherYear);
  }
  return {
    series: pvSeries(fetched, weatherYear, y, version),
    surfaces: used,
    pvgis: { version, weatherYear, keys: fetched.map((f) => f.key), fetchedAt: fetched.map((f) => f.at), fallback },
    seriesId: null,
    weatherYear,
  };
}

export async function prepareRun(analysis: AnalysisRow, opts: RunOptions): Promise<PreparedRun> {
  const s = parseSettings(analysis.settings);
  const q = opts.quote;
  const notes: string[] = [];
  const issues: AnalysisIssue[] = [];
  const { from, to, firstDay, lastDay } = periodBounds(s);
  if (to > Date.now() + HOUR) throw bad("Perioden er ikke over ennå. Velg «hittil i år» med en dato bak oss, eller et tidligere år.");

  // ---- sted og prisområde
  let { lat, lon, priceArea } = s.location;
  if ((lat == null || lon == null || !priceArea) && s.location.address) {
    const g = await geocode(s.location.address);
    lat ??= g.lat;
    lon ??= g.lon;
    if (!priceArea && g.priceArea) priceArea = g.priceArea;
  }
  if (lat == null || lon == null) throw bad("Mangler adresse eller koordinater for anlegget.");
  if (!priceArea) throw bad("Velg prisområde (NO1–NO5).");
  if (s.location.priceAreaSource === "foreslått" || !s.location.priceArea)
    issues.push({ level: "antakelse", field: "sted", message: `Prisområde ${priceArea} er foreslått fra adressen. Kontroller – prisområdet sier ikke hvilket nettselskap kunden har.` });

  // ---- tariff: periode, kundegruppe, bekreftelse
  const tariff = await loadTariff(s.meteringPoint.tariffId, s.meteringPoint.tariffConfirmed);
  const coversPeriod = tariffCovers(tariff, firstDay, lastDay);
  if (!coversPeriod && !s.meteringPoint.tariffScenario)
    issues.push({
      level: "feil",
      field: "tariff",
      message: `Tariffen gjelder ${tariff.validFrom} – ${tariff.validTo ?? "nå"} og dekker ikke ${s.period.kind === "år" ? s.period.year : `perioden til ${lastDay}`}. Velg riktig tariffversjon, legg inn satsene fra nettleiefakturaen, eller merk den som scenario.`,
    });
  else if (!coversPeriod)
    issues.push({ level: "advarsel", field: "tariff", message: `Scenario: nettleien er regnet med en tariff for ${tariff.validFrom} – ${tariff.validTo ?? "nå"}, ikke for analyseperioden.` });
  if (tariff.archived) issues.push({ level: "advarsel", field: "tariff", message: "Valgt tariff er arkivert. Kontroller at den fortsatt er riktig, eller velg en annen." });
  if (!s.meteringPoint.tariffConfirmed)
    issues.push({ level: "antakelse", field: "tariff", message: "Tariff og kundegruppe er ikke bekreftet mot kundens nettleiefaktura." });

  const prod = await production(s, opts, analysis.id, lat, lon, issues);

  // ---- forbruk
  let consumption: AnalysisInput["consumption"];
  let loadSeriesId: string | null = null;
  let annualKwh: number | null = null;
  const c = s.consumption;
  if (c.level === 3) {
    const row = await activeSeries(analysis.id, s.meteringPoint.id, "forbruk");
    if (!row) throw bad("Målt forbruk er valgt, men ingen forbruksfil er importert.");
    const series = rowToSeries(row);
    if (!covers(series, from, to))
      throw bad(`Målt forbruk dekker ${row.provenance.period?.from ?? "?"} – ${row.provenance.period?.to ?? "?"}, ikke analyseperioden. Velg et år filen dekker.`);
    if (series.resolutionMin !== 60) throw bad("Kvartersdata summeres til timer i neste versjon. Last opp timesverdier inntil videre.");
    consumption = {
      level: 3,
      series,
      report: row.quality ?? { intervals: series.values.length, expectedIntervals: series.values.length, resolutionMin: 60, firstLocal: "", lastLocal: "", sumKwh: seriesSum(series.values), missing: 0, duplicates: 0, estimated: 0, issues: [] },
    };
    loadSeriesId = row.id;
    annualKwh = seriesSum(series.values);
  } else if (c.level === 2) {
    if (!c.monthlyKwh) throw bad("Oppgi forbruk for alle tolv måneder.");
    consumption = { level: 2, type: s.businessType, monthlyKwh: c.monthlyKwh, openHours: s.openHours ?? undefined };
    annualKwh = c.monthlyKwh.reduce((a, b) => a + b, 0);
    issues.push({ level: "antakelse", field: "forbruk", message: "Fordelingen over døgnet er anslått fra virksomhetstype og driftstid (månedssummene er kundens)." });
  } else {
    if (!c.annualKwh) throw bad("Oppgi årsforbruk (eller et anslag).");
    consumption = { level: 1, type: s.businessType, annualKwh: c.annualKwh, openHours: s.openHours ?? undefined };
    annualKwh = c.annualKwh;
    issues.push({
      level: "antakelse",
      field: "forbruk",
      message: `Forbruket er en anslått profil for ${s.businessType} (${c.annualKwhStatus === "målt" ? "årsforbruk fra kunden" : "årsforbruket er et anslag"}).`,
    });
  }
  if (!covers(prod.series, from, to)) throw bad("Produksjonsserien dekker ikke analyseperioden.");

  // Kundegruppe mot årsforbruk (f.eks. «over 100 000 kWh»)
  if (annualKwh != null) {
    const scale = s.period.kind === "år" ? 1 : 1; // delår sammenlignes ikke med årsgrenser
    if (s.period.kind === "år" && tariff.minAnnualKwh != null && annualKwh * scale < tariff.minAnnualKwh)
      issues.push({ level: "advarsel", field: "tariff", message: `Tariffen gjelder kunder over ${tariff.minAnnualKwh.toLocaleString("nb-NO")} kWh/år, men forbruket er ${Math.round(annualKwh).toLocaleString("nb-NO")} kWh. Kontroller kundegruppen.` });
    if (s.period.kind === "år" && tariff.maxAnnualKwh != null && annualKwh > tariff.maxAnnualKwh)
      issues.push({ level: "advarsel", field: "tariff", message: `Tariffen gjelder kunder under ${tariff.maxAnnualKwh.toLocaleString("nb-NO")} kWh/år, men forbruket er ${Math.round(annualKwh).toLocaleString("nb-NO")} kWh.` });
  }

  // ---- spotpriser
  const spot = await spotRows(priceArea, firstDay, lastDay, opts.refresh);
  if (spot.unavailable.length)
    throw bad(`Mangler spotpriser for ${spot.unavailable.length} døgn (f.eks. ${spot.unavailable.slice(0, 2).join(", ")}). Prøv igjen senere.`);
  const prices = buildPriceSeries(spot.rows, priceArea);
  notes.push(...prices.notes);

  // ---- elavgift: periodens satser for avgiftsstatusen, eller oppgitt egen sats
  const el = s.meteringPoint.elavgift;
  let taxes: AnalysisInput["taxes"];
  if (el.orePerKwh != null) {
    taxes = {
      elavgiftOrePerKwh: el.orePerKwh,
      status: el.taxStatus,
      provenance: { status: "målt", sourceType: "oppgitt", source: `Oppgitt av selger: ${el.orePerKwh} øre/kWh for hele perioden` },
    };
    if (el.orePerKwh > 25)
      issues.push({ level: "advarsel", field: "elavgift", message: `Elavgift ${el.orePerKwh} øre/kWh er uvanlig høyt. Kontroller at nettleie eller mva. ikke er tatt med i satsen.` });
  } else {
    const status = el.taxStatus === "ukjent" ? "ordinær" : el.taxStatus;
    const tp = taxPeriods(status, firstDay, lastDay);
    if (tp.missing)
      issues.push({ level: "feil", field: "elavgift", message: `Mangler ${status === "redusert" ? "redusert" : "ordinær"} elavgiftssats fra ${tp.missing}. Oppgi egen sats.` });
    if (el.taxStatus === "ukjent")
      issues.push({ level: "antakelse", field: "elavgift", message: "Avgiftsstatus er ukjent: regnet med ordinær elavgift. Virksomhetstype alene bekrefter ikke rett til redusert sats." });
    taxes = {
      elavgiftOrePerKwh: 0,
      periods: tp.periods.map((p) => ({ from: p.from, to: p.to, orePerKwh: p.orePerKwh })),
      status: el.taxStatus,
      provenance: {
        status: el.taxStatus === "ukjent" ? "antatt" : "beregnet",
        sourceType: el.taxStatus === "ukjent" ? "antatt" : "beregnet",
        source: `${status === "fritak" ? "Fritak" : `${status === "redusert" ? "Redusert" : "Ordinær"} sats per periode`}: ${[...new Set(tp.periods.map((p) => p.source))].join("; ")}`,
      },
    };
  }

  // ---- investering, drift og utskifting
  const inv = s.economy.investment;
  const investmentNok = inv.source === "manuell" ? inv.nok : inv.source === "kalkyle" ? q.investmentNok : null;
  if (inv.source === "kalkyle" && q.investmentNok == null)
    issues.push({ level: "antakelse", field: "økonomi", message: q.investmentNote ?? "Tilbudet har ingen sum ennå – investeringen er uavklart." });
  if (q.batteryOffered)
    issues.push({ level: "antakelse", field: "økonomi", message: "Tilbudet har batteri som tillegg. Batteriets nytte og kostnad er ikke med i denne analysen (kommer i batterimodulen)." });

  let opex = s.economy.opex.filter((o) => o.nokPerYear > 0);
  if (!opex.length && q.maintenancePerYear > 0) {
    opex = [{ name: "Service (Beregningsregler)", nokPerYear: q.maintenancePerYear }];
    issues.push({ level: "antakelse", field: "økonomi", message: `Service ${q.maintenancePerYear.toLocaleString("nb-NO")} kr/år er standardverdien fra Beregningsregler, ikke avtalt for dette anlegget.` });
  } else if (!opex.length)
    issues.push({ level: "antakelse", field: "økonomi", message: "Ingen løpende kostnader (service, styring o.l.) er oppgitt. Netto gevinst er da lik lavere energikostnad." });

  let replacements = s.economy.replacements;
  if (s.economy.replacementSource === "kalkyle") {
    if (q.inverterNok && q.inverterNok > 0) {
      const nok = Math.round(q.inverterNok * q.replacementFactor);
      replacements = [{ name: `Inverterbytte (${q.inverterNames.join(", ")} × ${q.replacementFactor} inkl. arbeid)`, year: q.replacementYear, nok }];
      issues.push({ level: "antakelse", field: "økonomi", message: `Inverterbytte år ${q.replacementYear}: ${nok.toLocaleString("nb-NO")} kr = tilbudets inverterpris × ${q.replacementFactor} (Beregningsregler), utbetalt i år ${q.replacementYear}.` });
    } else {
      replacements = [];
      issues.push({ level: "advarsel", field: "økonomi", message: "Tilbudet har ingen inverter med pris – inverterbytte er ikke med. Legg inn et anslag." });
    }
  } else if (s.economy.replacementSource === "ingen") replacements = [];

  // ---- inverter og eksport
  if (q.inverterAcKw == null && q.inverterNames.length)
    issues.push({ level: "antakelse", field: "produksjon", message: "Inverterens AC-effekt mangler i produktdata. Solproduksjonen er ikke begrenset av inverteren." });
  if (s.meteringPoint.exportLimitKw == null)
    issues.push({ level: "antakelse", field: "avtaler", message: "Eksportgrensen er ukjent og regnes som ubegrenset. Bekreft fra nettilknytningen." });
  if (s.goals.some((g) => g === "lading" || g === "nødstrøm"))
    issues.push({ level: "antakelse", field: "mål", message: "Lading og nødstrøm er valgt som mål, men beregnes ikke ennå." });

  const mp = s.meteringPoint;
  const input: AnalysisInput = {
    project: { name: "", address: s.location.address, priceArea, businessType: s.businessType },
    meteringPoint: { id: mp.id, label: mp.label },
    period: s.period,
    consumption,
    production: prod.series,
    spot: prices.series,
    tariff,
    tariffScenario: !coversPeriod && s.meteringPoint.tariffScenario,
    taxes,
    buy: {
      type: "spot",
      markupOrePerKwh: mp.buy.markupOrePerKwh,
      monthlyFeeNok: mp.buy.monthlyFeeNok,
      provenance: { status: mp.buy.status, sourceType: mp.buy.status === "antatt" ? "antatt" : "oppgitt", source: mp.buy.status === "antatt" ? "Antatt (kundens avtale ikke registrert)" : "Kundens avtale (oppgitt)" },
    },
    sell: {
      type: "spot",
      deductionOrePerKwh: mp.sell.deductionOrePerKwh,
      provenance: { status: mp.sell.status, sourceType: mp.sell.status === "antatt" ? "antatt" : "oppgitt", source: mp.sell.status === "antatt" ? "Antatt (ingen salgsavtale registrert)" : "Kundens salgsavtale (oppgitt)" },
    },
    exportLimitKw: mp.exportLimitKw,
    inverterAcKw: q.inverterAcKw,
    weatherYear: prod.weatherYear,
    issues,
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
      opex,
      replacements,
    },
    scenarios: s.scenarios.map((x) => ({ name: x.name, kraftGrowth: x.kraftGrowthPct / 100 })),
  };

  const { dbId, archived, provenance, ...def } = tariff;
  void archived;
  void provenance;
  return {
    input,
    settings: s,
    meta: {
      surfaces: prod.surfaces,
      pvgis: prod.pvgis,
      spot: { area: priceArea, days: Math.round((to - from) / HOUR / 24), fetched: spot.fetched },
      loadSeriesId,
      productionSeriesId: prod.seriesId,
      tariff: { id: dbId, name: tariff.name, gridOwner: tariff.gridOwner, validFrom: tariff.validFrom, validTo: tariff.validTo, definition: def },
      investmentSource: inv.source,
      quote: q,
      issues,
      notes,
    },
  };
}

export function execute(p: PreparedRun) {
  const result = runAnalysis(p.input);
  for (const n of p.meta.notes) result.issues.push({ level: "antakelse", field: "kilder", message: n });
  result.warnings = result.issues.map((i) => i.message);
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
    clippedKwh: r0(e.total.clippedKwh),
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
    years: res.years,
    historical: {
      energySaving: r0(res.historical.energySaving),
      opex: r0(res.historical.opex),
      net: r0(res.historical.net),
      opexItems: res.historical.opexItems.map((o) => ({ name: o.name, nok: r0(o.nok) })),
    },
    scope: {
      solar: true,
      battery: false,
      batteryOffered: p.meta.quote.batteryOffered,
      inverterAcKw: p.meta.quote.inverterAcKw,
      clippedKwh: r0(res.after.total.clippedKwh),
    },
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
      replacements: p.input.economy.replacements,
      opexUsed: p.input.economy.opex,
      vat: "Alle beløp eks. mva.",
      beforeTax: "Prosjektøkonomi før skatt og finansiering.",
    },
    basis: res.basis,
    issues: res.issues,
    valid: res.valid,
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
