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
import { concatYears, periodRange, runAnalysis, type AnalysisInput, type AnalysisResult, type BasisLine, type BatteryInput, type MeterInput } from "@/lib/naering/analysis";
import { chargingProfile } from "@/lib/naering/profiles";
import type { BatteryOfferResult } from "@/lib/quote/battery";
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
  /** Batteriet i tilbudet (kalkylelinjer eller anbefalt tillegg), for batterimodulen. null = ingen */
  battery: QuoteBattery | null;
  /** Fra Beregningsregler */
  replacementYear: number;
  replacementFactor: number;
  maintenancePerYear: number;
}

export interface QuoteBattery {
  source: "kalkyle" | "tillegg";
  label: string;
  /** Nominell kapasitet (kWh) */
  capacityKwh: number | null;
  /** Lade-/utladeeffekt (kW): batteriets effekt, begrenset av hybridinverteren når den er kjent */
  powerKw: number | null;
  powerNote: string;
  usablePct: number | null;
  roundTripPct: number | null;
  lifeYears: number | null;
  /** Batteriets del av investeringen (kr eks. mva.) */
  investmentNok: number | null;
  investmentNote: string;
  /** Hybridinverterens AC-effekt som sol og batteri deler (kW). null = ukjent */
  sharedAcKw: number | null;
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
  offer?: BatteryOfferResult | null,
): QuoteContext {
  const share = result.totals.subtotal > 0 ? result.totals.totalExVat / result.totals.subtotal : 1;
  let ac = 0;
  let acUnknown = false;
  let inverterNok = 0;
  let hybridAc = 0;
  const names: string[] = [];
  // Batterilinjer i grunnkalkylen
  let batNok = 0, batKwh = 0, batKwhUnknown = false, batPower = 0, batPowerUnknown = false;
  const batNames: string[] = [];
  const tech = { usable: [] as number[], rt: [] as number[], life: [] as number[] };
  built.input.lines.forEach((l, i) => {
    const qty = Number(String(l.quantity).replace(",", ".")) || 0;
    if (l.productKind === "batteri") {
      batNok += ((result.lines[i]?.sale ?? 0) * share) / 100;
      const cap = Number(l.meta?.capacityKwh);
      if (cap > 0) batKwh += cap * qty;
      else if (l.meta?.source === "catalog") batKwhUnknown = true;
      const pw = Number(l.meta?.powerKw);
      if (pw > 0) batPower += pw * qty;
      else if (cap > 0) batPowerUnknown = true;
      if (Number(l.meta?.usablePct) > 0) tech.usable.push(Number(l.meta?.usablePct));
      if (Number(l.meta?.roundTripPct) > 0) tech.rt.push(Number(l.meta?.roundTripPct));
      if (Number(l.meta?.lifeYears) > 0) tech.life.push(Number(l.meta?.lifeYears));
      if (cap > 0) batNames.push(`${qty} × ${String(l.meta?.productName ?? "batteri")}`);
      return;
    }
    if (l.productKind !== "inverter") return;
    const acKw = Number(l.meta?.acKw);
    if (acKw > 0) ac += acKw * qty;
    else acUnknown = true;
    if (l.meta?.hybrid === true && acKw > 0) hybridAc += acKw * qty;
    inverterNok += ((result.lines[i]?.sale ?? 0) * share) / 100;
    names.push(String(l.meta?.productName ?? "inverter"));
  });
  const a = settings.offerAssumptions ?? {};
  const hasBatteryLines = batNok > 0 || batKwh > 0 || Boolean(draft.battery);

  let battery: QuoteBattery | null = null;
  if (hasBatteryLines) {
    const power = batPower > 0 && !batPowerUnknown ? batPower : null;
    const limited = power != null && hybridAc > 0 ? Math.min(power, hybridAc) : (power ?? (hybridAc > 0 ? hybridAc : null));
    battery = {
      source: "kalkyle",
      label: batNames.join(" + ") || "Batteri i kalkylen",
      capacityKwh: batKwh > 0 && !batKwhUnknown ? batKwh : null,
      powerKw: limited,
      powerNote: power != null ? (hybridAc > 0 && hybridAc < power ? `Begrenset av hybridinverteren (${hybridAc} kW AC)` : "Fra produktdata") : hybridAc > 0 ? `Hybridinverterens AC-effekt (${hybridAc} kW)` : "",
      usablePct: tech.usable.length ? Math.min(...tech.usable) : null,
      roundTripPct: tech.rt.length ? Math.min(...tech.rt) : null,
      lifeYears: tech.life.length ? Math.min(...tech.life) : null,
      investmentNok: batNok > 0 ? batNok : null,
      investmentNote: "Batterilinjene i kalkylen (kundepris eks. mva.)",
      sharedAcKw: hybridAc > 0 ? hybridAc : null,
    };
  } else if (offer?.enabled && offer.recommended) {
    // Anbefalt batteri fra batteritillegget i tilbudet
    const m = offer.models.find((x) => x.productId === offer.recommended!.model);
    if (m) {
      const n = offer.recommended.modules;
      const bmsCount = m.bms ? Math.ceil(n / Math.max(1, m.modulesPerBms)) : 0;
      const ore = n * m.module.customerOre + bmsCount * (m.bms?.customerOre ?? 0) + (offer.hybridIncluded ? 0 : offer.upgrade.customerOre) + (offer.install?.customerOre ?? 0);
      const hyb = offer.hybridIncluded ? (offer.stringInverter?.acKw ?? null) : offer.hybrid?.acKw != null ? offer.hybrid.acKw * offer.hybrid.quantity : null;
      const power = m.tech?.powerKw ? m.tech.powerKw * (m.structure === "modular" ? n : n) : null;
      const limited = power != null && hyb != null ? Math.min(power, hyb) : (power ?? hyb);
      battery = {
        source: "tillegg",
        label: `${m.name}, ${n} ${m.structure === "modular" ? "moduler" : "enheter"} (${(n * m.moduleKwh).toLocaleString("nb-NO")} kWh)`,
        capacityKwh: m.moduleKwh > 0 ? n * m.moduleKwh : null,
        powerKw: limited,
        powerNote: power != null ? (hyb != null && hyb < power ? `Begrenset av hybridinverteren (${hyb} kW AC)` : "Fra produktdata") : hyb != null ? `Hybridinverterens AC-effekt (${hyb} kW)` : "",
        usablePct: m.tech?.usablePct ?? null,
        roundTripPct: m.tech?.roundTripPct ?? null,
        lifeYears: m.tech?.lifeYears ?? null,
        investmentNok: ore / 100,
        sharedAcKw: hyb,
        investmentNote: `Anbefalt batteri i tilbudet: moduler${bmsCount ? ", BMS" : ""}${offer.hybridIncluded ? "" : ", hybridoppgradering"}${offer.install ? " og installasjon" : ""} (kundepris eks. mva.)`,
      };
    }
  }
  return {
    kwp: built.kwp > 0 ? built.kwp : null,
    // Solcelledelen: kalkylens sum minus batterilinjene
    investmentNok: result.totals.totalExVat / 100 - (hasBatteryLines ? batNok : 0),
    investmentNote: hasBatteryLines ? "Solcelledelen = kalkylens sum minus batterilinjene." : undefined,
    inverterAcKw: names.length && !acUnknown ? ac : null,
    inverterNok: names.length ? inverterNok : null,
    inverterNames: names,
    batteryOffered: draft.batteryOffer?.enabled === true || hasBatteryLines,
    battery,
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
    otherMeters: { id: string; label: string; tariffId: string; loadSeriesId: string | null }[];
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
  const r = periodRange(s.period);
  if (!Number.isFinite(r.to) || !Number.isFinite(r.from)) throw bad("Ugyldig dato for perioden.");
  return { from: r.from, to: r.to, firstDay: r.fromDay, lastDay: r.lastDay, years: r.years, label: r.label };
}

/** Kvartersverdier summeres til timer (energi). Ufullstendige timer blir NaN (stopper beregningen hvis de trengs). */
export function toHourly(s: TimeSeries): TimeSeries {
  if (s.resolutionMin === 60) return s;
  const start = Math.ceil(s.startUtc / HOUR) * HOUR;
  const skip = (start - s.startUtc) / (15 * 60_000);
  const n = Math.floor((s.values.length - skip) / 4);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += s.values[skip + i * 4 + k];
    v[i] = sum;
  }
  return {
    ...s,
    startUtc: start,
    resolutionMin: 60,
    values: v,
    provenance: { ...s.provenance, note: `${s.provenance.note ? `${s.provenance.note} ` : ""}Kvartersverdier summert til timer (effektleddet regnes per time).`.trim() },
  };
}

const zeroLike = (s: TimeSeries): TimeSeries => ({ ...s, values: new Float64Array(s.values.length), provenance: { ...s.provenance, source: "Ingen solceller på hovedmåleren" } });

function covers(series: TimeSeries, from: number, to: number) {
  const end = series.startUtc + series.values.length * series.resolutionMin * 60_000;
  return series.startUtc <= from && end >= to;
}

async function production(s: BusinessSettings, opts: RunOptions, analysisId: string, lat: number, lon: number, issues: AnalysisIssue[]) {
  const y = s.period.year;
  const years = periodRange(s.period).years;
  const mainMp = s.meteringPoint.id;
  const meterIds = new Set([mainMp, ...s.otherMeters.map((m) => m.id)]);
  const mpOf = (x: { meteringPointId?: string | null }) => (x.meteringPointId && meterIds.has(x.meteringPointId) ? x.meteringPointId : mainMp);
  const kwp = opts.quote.kwp;

  // Takflater: fra tilbudet/solkartet, ellers en synlig eksempelrad
  let surfaces = s.production.surfaces;
  if (!surfaces.length) {
    surfaces = [{ id: "eksempel", label: "Eksempel: én flate mot sør, 15°", panels: null, kwp: null, tiltDeg: 15, azimuthDeg: 180, assumed: true, meteringPointId: null, shadingPct: 0 }];
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
    meteringPointId: mpOf(x),
    shadingPct: x.shadingPct ?? 0,
  }));
  const shaded = used.filter((u) => u.shadingPct > 0);
  if (shaded.length)
    issues.push({ level: "antakelse", field: "takflater", message: `Skyggetap er trukket fra: ${shaded.map((u) => `${u.label} ${u.shadingPct} %`).join(", ")} (oppgitt anslag, i tillegg til terrenget PVGIS regner med).` });

  if (s.production.source === "fil") {
    const row = await activeSeries(analysisId, mainMp, "produksjon");
    if (!row) throw bad("Produksjon fra fil er valgt, men ingen produksjonsfil er importert.");
    if (used.some((u) => u.meteringPointId !== mainMp))
      issues.push({ level: "advarsel", field: "takflater", message: "Produksjonsfilen regnes på hovedmåleren. Takflater på andre målere brukes bare med PVGIS." });
    const series = row.resolution_min === 15 ? toHourly(rowToSeries(row)) : rowToSeries(row);
    return { series, byMeter: new Map([[mainMp, series]]), surfaces: used, pvgis: null, seriesId: row.id, weatherYear: null };
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
      const f = surf.kwp * (1 - surf.shadingPct / 100);
      out.push({ surface: surf, parsed: { ...parsed, kwh: parsed.kwh.map((k) => k * f) }, key: ref.key, at: ref.fetchedAt });
    }
    if (!out.length) throw bad("Anlegget har 0 kWp.");
    for (const ty of years) alignToYear(out[0].parsed, wy, ty); // kaster hvis serien ikke dekker året
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
  // Én serie per målepunkt (flater kan ligge bak ulike målere)
  // Perioder over et årsskifte: samme værår lagt på kalenderen for hvert år i perioden
  const seriesFor = (list: typeof fetched) => concatYears(years.map((ty) => pvSeries(list, weatherYear, ty, version)));
  const byMeter = new Map<string, TimeSeries>();
  for (const id of new Set(fetched.map((f) => f.surface.meteringPointId)))
    byMeter.set(id, seriesFor(fetched.filter((f) => f.surface.meteringPointId === id)));
  void y;
  return {
    series: byMeter.get(mainMp) ?? zeroLike(seriesFor(fetched)),
    byMeter,
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

  // ---- forbruk (hovedmåler og eventuelle andre målere)
  const loadFor = async (mpId: string, c: BusinessSettings["consumption"], who: string) => {
    let consumption: AnalysisInput["consumption"];
    let seriesId: string | null = null;
    let annual: number | null = null;
    const prefix = who ? `${who}: ` : "";
    if (c.level === 3) {
      const row = await activeSeries(analysis.id, mpId, "forbruk");
      if (!row) throw bad(`${prefix}Målt forbruk er valgt, men ingen forbruksfil er importert.`);
      // Kvartersdata beholdes når kunden avregnes per kvarter; ellers summeres de til timer
      const keepQuarter = row.resolution_min === 15 && s.meteringPoint.settlement === "kvarter" && mpId === s.meteringPoint.id;
      const series = keepQuarter ? rowToSeries(row) : toHourly(rowToSeries(row));
      if (!covers(series, from, to))
        throw bad(`${prefix}Målt forbruk dekker ${row.provenance.period?.from ?? "?"} – ${row.provenance.period?.to ?? "?"}, ikke analyseperioden. Velg et år filen dekker.`);
      if (row.resolution_min === 15 && !keepQuarter)
        issues.push({ level: "antakelse", field: "forbruk", message: `${prefix}Kvartersforbruket er summert til timer (kunden avregnes per time). Velg kvartersavregning for å regne per kvarter.` });
      if (keepQuarter)
        issues.push({ level: "antakelse", field: "forbruk", message: `${prefix}Regnet per kvarter. Solproduksjon (PVGIS, timeverdier) er fordelt likt på kvarterene i timen.` });
      if (row.resolution_min === 60 && s.meteringPoint.settlement === "kvarter" && mpId === s.meteringPoint.id)
        issues.push({ level: "antakelse", field: "forbruk", message: `${prefix}Kvartersavregning er valgt, men forbruket er målt per time. Regnet per time – timeforbruk blir ikke kvartersforbruk av å fordeles.` });
      consumption = {
        level: 3,
        series,
        report: row.quality ?? { intervals: series.values.length, expectedIntervals: series.values.length, resolutionMin: 60, firstLocal: "", lastLocal: "", sumKwh: seriesSum(series.values), missing: 0, duplicates: 0, estimated: 0, issues: [] },
      };
      seriesId = row.id;
      annual = seriesSum(series.values);
    } else if (c.level === 2) {
      if (!c.monthlyKwh) throw bad(`${prefix}Oppgi forbruk for alle tolv måneder.`);
      consumption = { level: 2, type: s.businessType, monthlyKwh: c.monthlyKwh, openHours: s.openHours ?? undefined, schedule: s.schedule };
      annual = c.monthlyKwh.reduce((a, b) => a + b, 0);
      issues.push({ level: "antakelse", field: "forbruk", message: `${prefix}Fordelingen over døgnet er anslått fra virksomhetstype og driftstid (månedssummene er kundens).` });
    } else {
      if (!c.annualKwh) throw bad(`${prefix}Oppgi årsforbruk (eller et anslag).`);
      consumption = { level: 1, type: s.businessType, annualKwh: c.annualKwh, openHours: s.openHours ?? undefined, schedule: s.schedule };
      annual = c.annualKwh;
      const src = c.source === "faktura" ? "fra faktura" : c.source === "kunde" ? "oppgitt av kunden" : c.annualKwhStatus === "målt" ? "fra kunden" : "et anslag";
      issues.push({ level: "antakelse", field: "forbruk", message: `${prefix}Forbruket er en anslått profil for ${s.businessType} (årsforbruket er ${src}).` });
    }
    return { consumption, seriesId, annual };
  };
  const mainLoad = await loadFor(s.meteringPoint.id, s.consumption, s.otherMeters.length ? s.meteringPoint.label : "");
  const consumption = mainLoad.consumption;
  const loadSeriesId = mainLoad.seriesId;
  const annualKwh = mainLoad.annual;
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
  const quarterLoad = consumption.level === 3 && consumption.series.resolutionMin === 15;
  const spotSeries = quarterLoad && prices.quarterSeries ? prices.quarterSeries : prices.series;

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
  const expMain = exportLimit(s.meteringPoint);
  if (expMain.unknown)
    issues.push({ level: "antakelse", field: "avtaler", message: "Eksportgrensen er ukjent og regnes som ubegrenset. Bekreft fra nettilknytningen." });
  if (s.goals.includes("lading") && !(s.charging.enabled && s.charging.chargers.length))
    issues.push({ level: "antakelse", field: "mål", message: "Lading er valgt som mål, men ingen ladepunkter er lagt inn. Legg dem inn under «Lading», ellers regnes de ikke med." });
  if (s.goals.includes("nødstrøm") && !q.battery && s.battery.include !== "ja")
    issues.push({ level: "antakelse", field: "mål", message: "Nødstrøm er valgt som mål, men tilbudet har ikke batteri. Nødstrøm regnes ikke." });

  // ---- mva.
  const vatFactor = s.economy.vatDeductible === "nei" ? 1.25 : 1;
  const vatNote =
    s.economy.vatDeductible === "nei"
      ? { value: "Kostnader og investering inkl. 25 % mva. (salg uten mva.)", status: "målt" as const, sourceType: "oppgitt" as const, source: "Kunden har ikke fradragsrett (oppgitt)" }
      : s.economy.vatDeductible === "ja"
        ? { value: "Alle beløp eks. mva.", status: "målt" as const, sourceType: "oppgitt" as const, source: "Kunden har fradragsrett (oppgitt)" }
        : { value: "Alle beløp eks. mva.", status: "antatt" as const, sourceType: "antatt" as const, source: "Kundens fradragsrett ikke registrert – regnet som eks. mva." };
  if (s.economy.vatDeductible === "ukjent")
    issues.push({ level: "antakelse", field: "økonomi", message: "Fradragsrett for mva. er ikke registrert. Beløpene er eks. mva." });

  // ---- andre målere
  const otherMeters: MeterInput[] = [];
  const otherLoadIds = new Map<string, string | null>();
  for (const m of s.otherMeters) {
    const tr = await loadTariff(m.tariffId, m.tariffConfirmed).catch(() => {
      throw bad(`${m.label}: velg nettariff for måleren.`);
    });
    if (!tariffCovers(tr, firstDay, lastDay) && !m.tariffScenario)
      issues.push({ level: "feil", field: `måler:${m.id}`, message: `${m.label}: tariffen gjelder ${tr.validFrom} – ${tr.validTo ?? "nå"} og dekker ikke analyseperioden. Velg riktig versjon eller merk den som scenario.` });
    if (!m.tariffConfirmed) issues.push({ level: "antakelse", field: `måler:${m.id}`, message: `${m.label}: tariffen er ikke bekreftet mot nettleiefakturaen.` });
    const ld = await loadFor(m.id, m.consumption, m.label);
    otherLoadIds.set(m.id, ld.seriesId);
    const ex = exportLimit(m);
    if (ex.unknown && prod.byMeter.has(m.id)) issues.push({ level: "antakelse", field: `måler:${m.id}`, message: `${m.label}: eksportgrensen er ukjent og regnes som ubegrenset.` });
    otherMeters.push({
      id: m.id,
      label: m.label,
      consumption: ld.consumption,
      production: prod.byMeter.get(m.id) ?? null,
      tariff: tr,
      tariffScenario: !tariffCovers(tr, firstDay, lastDay) && m.tariffScenario,
      exportLimitKw: ex.kw,
      importLimitKw: m.importLimitKw,
      inverterAcKw: null,
    });
  }
  if (otherMeters.length && q.inverterAcKw != null && prod.byMeter.size > 1)
    issues.push({ level: "antakelse", field: "produksjon", message: "Solcellene er fordelt på flere målere. Inverterkapping er bare regnet for hovedmåleren." });

  // ---- lading
  let extraLoad: TimeSeries | null = null;
  let extraOther: { id: string; series: TimeSeries } | null = null;
  if (s.charging.enabled && s.charging.chargers.length) {
    if (s.charging.inConsumption)
      issues.push({ level: "antakelse", field: "lading", message: "Ladingen er oppgitt å være med i forbruksdataene og er ikke lagt til på nytt." });
    else {
      const prof = concatYears(periodRange(s.period).years.map((yr) => chargingProfile(yr, s.charging.chargers)));
      const target = s.charging.meteringPointId && s.otherMeters.some((m) => m.id === s.charging.meteringPointId) ? s.charging.meteringPointId : s.meteringPoint.id;
      if (target === s.meteringPoint.id) extraLoad = prof;
      else extraOther = { id: target, series: prof };
      issues.push({ level: "antakelse", field: "lading", message: "Ladingen er et anslag (jevnt fordelt i ladevinduet) og er lagt til forbruket i alle alternativer." });
    }
  }
  if (extraOther) {
    const om = otherMeters.find((m) => m.id === extraOther!.id);
    if (om) om.extraLoad = extraOther.series;
  }

  // ---- batteri
  const battery = batteryInput(s, q, issues, vatFactor);

  const mp = s.meteringPoint;
  const input: AnalysisInput = {
    project: { name: "", address: s.location.address, priceArea, businessType: s.businessType },
    meteringPoint: { id: mp.id, label: mp.label },
    period: s.period,
    consumption,
    production: prod.series,
    spot: spotSeries,
    tariff,
    tariffScenario: !coversPeriod && s.meteringPoint.tariffScenario,
    taxes,
    buy: {
      type: mp.buy.type === "fastpris" && mp.buy.fixedOrePerKwh != null ? "fastpris" : "spot",
      fixedOrePerKwh: mp.buy.fixedOrePerKwh,
      markupOrePerKwh: mp.buy.markupOrePerKwh,
      monthlyFeeNok: mp.buy.monthlyFeeNok,
      provenance: { status: mp.buy.status, sourceType: mp.buy.status === "antatt" ? "antatt" : "oppgitt", source: mp.buy.status === "antatt" ? "Antatt (kundens avtale ikke registrert)" : "Kundens avtale (oppgitt)" },
    },
    sell: {
      type: mp.sell.type === "fastpris" && mp.sell.fixedOrePerKwh != null ? "fastpris" : "spot",
      fixedOrePerKwh: mp.sell.fixedOrePerKwh,
      deductionOrePerKwh: mp.sell.deductionOrePerKwh,
      floorOrePerKwh: mp.sell.floorOrePerKwh,
      provenance: { status: mp.sell.status, sourceType: mp.sell.status === "antatt" ? "antatt" : "oppgitt", source: mp.sell.status === "antatt" ? "Antatt (ingen salgsavtale registrert)" : "Kundens salgsavtale (oppgitt)" },
    },
    exportLimitKw: expMain.kw,
    importLimitKw: mp.importLimitKw,
    inverterAcKw: q.inverterAcKw,
    extraLoad,
    otherMeters,
    battery,
    vatFactor,
    vatNote,
    offerLabel: battery ? `Tilbudet: solcelleanlegg ${q.kwp != null ? `${q.kwp.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} kWp ` : ""}og ${battery.label}` : `Tilbudet: solcelleanlegg${q.kwp != null ? ` ${q.kwp.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} kWp` : ""}`,
    weatherYear: prod.weatherYear,
    issues,
    economy: {
      investmentNok: investmentNok == null ? null : investmentNok * vatFactor,
      years: s.economy.years,
      discountRate: s.economy.discountRatePct / 100,
      growth: {
        kraft: s.economy.growth.kraftPct / 100,
        nettleie: s.economy.growth.nettleiePct / 100,
        avgift: s.economy.growth.avgiftPct / 100,
        drift: s.economy.growth.driftPct / 100,
      },
      degradationPerYear: s.economy.degradationPct / 100,
      opex: opex.map((o) => ({ ...o, nokPerYear: o.nokPerYear * vatFactor })),
      replacements: replacements.map((r) => ({ ...r, nok: r.nok * vatFactor })),
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
      otherMeters: s.otherMeters.map((m) => ({ id: m.id, label: m.label, tariffId: m.tariffId ?? "", loadSeriesId: otherLoadIds.get(m.id) ?? null })),
      tariff: { id: dbId, name: tariff.name, gridOwner: tariff.gridOwner, validFrom: tariff.validFrom, validTo: tariff.validTo, definition: def },
      investmentSource: inv.source,
      quote: q,
      issues,
      notes,
    },
  };
}

function exportLimit(m: { exportLimitMode: "ukjent" | "ingen_grense" | "grense" | "ingen_eksport"; exportLimitKw: number | null }) {
  if (m.exportLimitMode === "ingen_eksport") return { kw: 0, unknown: false };
  if (m.exportLimitMode === "ingen_grense") return { kw: null, unknown: false };
  if (m.exportLimitMode === "grense" || m.exportLimitKw != null) return { kw: m.exportLimitKw, unknown: m.exportLimitKw == null };
  return { kw: null, unknown: true };
}

/**
 * Batteriet: verdier fra tilbudet (produktdata) eller skjemaet. Det som mangler, merkes som antatt
 * med en forsiktig standardverdi. Alle linjer vises i datagrunnlaget.
 */
function batteryInput(s: BusinessSettings, q: QuoteContext, issues: AnalysisIssue[], vatFactor: number): BatteryInput | null {
  const b = s.battery;
  if (b.include === "nei") {
    if (q.battery) issues.push({ level: "advarsel", field: "batteri", message: "Tilbudet har batteri, men batteriet er valgt bort i analysen. Resultatet gjelder solcellene alene." });
    return null;
  }
  const qb = q.battery;
  if (!qb && b.include !== "ja") return null;
  const basis: BasisLine[] = [];
  const line = (what: string, value: string, known: boolean, source: string) =>
    basis.push({ what, value, status: known ? "målt" : "antatt", sourceType: known ? "oppgitt" : "antatt", source });
  const nf = (x: number, d = 0) => x.toLocaleString("nb-NO", { maximumFractionDigits: d });

  const cap = b.capacityKwh ?? qb?.capacityKwh ?? null;
  if (cap == null || cap <= 0) {
    issues.push({ level: "feil", field: "batteri", message: "Batteriets kapasitet (kWh) mangler i produktdata. Legg den inn på produktet eller i batterikortet." });
    return null;
  }
  const usablePct = b.usablePct ?? qb?.usablePct ?? 90;
  const powerKw = b.powerKw ?? qb?.powerKw ?? cap * 0.5;
  const rt = b.roundTripPct ?? qb?.roundTripPct ?? 90;
  const reservePct = b.reservePct ?? (s.goals.includes("nødstrøm") ? 20 : 0);
  const life = qb?.lifeYears ?? b.lifeYears;
  const label = qb?.label ?? `Batteri ${nf(cap)} kWh`;
  line("Batteri", label, Boolean(qb), qb ? (qb.source === "kalkyle" ? "Fra kalkylen" : "Anbefalt batteri i tilbudets batteritillegg") : "Lagt inn i analysen");
  line("Kapasitet", `${nf(cap, 1)} kWh nominelt, ${nf(usablePct)} % brukbar = ${nf((cap * usablePct) / 100, 1)} kWh`, b.usablePct != null || qb?.usablePct != null, b.usablePct != null ? "Oppgitt i analysen" : qb?.usablePct != null ? "Produktdata" : "Brukbar andel antatt 90 % (mangler i produktdata)");
  line("Effekt (lading/utlading)", b.dischargeKw != null && b.dischargeKw !== powerKw ? `lading ${nf(powerKw, 1)} kW, utlading ${nf(b.dischargeKw, 1)} kW` : `${nf(powerKw, 1)} kW`, b.powerKw != null || qb?.powerKw != null, b.powerKw != null ? "Oppgitt i analysen" : qb?.powerNote || "Antatt 0,5 × kapasitet (mangler i produktdata)");
  if (qb?.sharedAcKw) line("Hybridinverter", `${nf(qb.sharedAcKw, 1)} kW AC delt mellom sol og batteri`, true, "Fra tilbudet: sol og batteriutlading kan til sammen ikke levere mer enn inverteren");
  line("Virkningsgrad tur-retur", `${nf(rt)} %`, b.roundTripPct != null || qb?.roundTripPct != null, b.roundTripPct != null ? "Oppgitt i analysen" : qb?.roundTripPct != null ? "Produktdata" : "Antatt 90 % (mangler i produktdata)");
  line("Nødstrømsreserve", `${nf(reservePct)} % av brukbar kapasitet`, b.reservePct != null, b.reservePct != null ? "Oppgitt i analysen" : s.goals.includes("nødstrøm") ? "Antatt 20 % fordi nødstrøm er valgt som mål" : "Ingen reserve");
  line("Hjelpelast", `${nf(b.auxKw, 2)} kW`, b.auxKw > 0, b.auxKw > 0 ? "Oppgitt i analysen" : "Ikke oppgitt – regnet som 0");
  line("Aldring og levetid", `${nf(b.degradationPct, 1)} % per år, levetid ${life} år`, qb?.lifeYears != null, qb?.lifeYears != null ? "Levetid fra produktdata, aldring antatt" : "Antatt");
  line("Energiveier", `${b.gridCharge ? "lading fra nett tillatt" : "ikke lading fra nett"} · ${b.gridExport ? "salg fra batteri tillatt" : "ikke salg fra batteri"}`, true, "Valgt i analysen (må være tillatt av utstyr, avtale og nettilknytning)");
  line("Styring", `Grunnstyring og smart prisstyring (plan kl. 13 med kjente spotpriser, persistensprognose), slitasjekostnad ${nf(b.wearOrePerKwh)} øre/kWh i styringen`, false, "Soleklarts representative strategi – ikke leverandørens algoritme");
  if (usablePct === 90 && b.usablePct == null && qb?.usablePct == null) issues.push({ level: "antakelse", field: "batteri", message: "Brukbar andel av batteriet er antatt 90 % (mangler i produktdata)." });
  if (b.powerKw == null && qb?.powerKw == null) issues.push({ level: "antakelse", field: "batteri", message: `Batteriets effekt er antatt ${nf(powerKw, 1)} kW (0,5 × kapasitet). Legg inn effekt på produktet.` });
  if (b.roundTripPct == null && qb?.roundTripPct == null) issues.push({ level: "antakelse", field: "batteri", message: "Virkningsgraden er antatt 90 % tur-retur (mangler i produktdata)." });
  if (s.meteringPoint.importLimitKw == null && b.gridCharge)
    issues.push({ level: "antakelse", field: "batteri", message: "Importgrensen er ukjent. Lading fra nett er ikke begrenset av tilknytningen." });

  const inv = b.investmentNok ?? qb?.investmentNok ?? null;
  line("Batteriinvestering", inv == null ? "uavklart" : `${nf(inv)} kr eks. mva.`, inv != null, b.investmentNok != null ? "Oppgitt i analysen" : qb?.investmentNote ?? "Mangler");
  if (inv == null) issues.push({ level: "advarsel", field: "batteri", message: "Batteriets investering er ukjent. Nåverdi og tilbakebetaling for batterialternativene vises ikke." });
  const fee = b.smartFeeNokPerYear;
  line("Smartstyring", fee == null ? "kostnad ikke oppgitt (regnet som 0)" : `${nf(fee)} kr/år${b.smartFeeOnceNok ? ` + ${nf(b.smartFeeOnceNok)} kr engang` : ""}`, fee != null, fee == null ? "Ikke oppgitt" : "Oppgitt i analysen");
  if (fee == null) issues.push({ level: "antakelse", field: "batteri", message: "Kostnaden for smartstyring er ikke oppgitt og regnet som 0. Smartstyringens merverdi kan derfor være for høy." });

  return {
    label,
    config: {
      usableKwh: (cap * usablePct) / 100,
      reserveShare: reservePct / 100,
      chargeKw: powerKw,
      dischargeKw: b.dischargeKw ?? powerKw,
      sharedAcKw: qb?.sharedAcKw ?? null,
      roundTrip: rt / 100,
      auxKw: b.auxKw,
      gridCharge: b.gridCharge,
      gridExport: b.gridExport,
      wearNokPerKwh: b.wearOrePerKwh / 100,
    },
    degradationPerYear: b.degradationPct / 100,
    lifeYears: life,
    investmentNok: inv == null ? null : inv * vatFactor,
    // Utskifting: batteriets investering uten hybridoppgradering er ukjent; hele beløpet brukes (forsiktig)
    replacementNok: inv == null ? null : inv * vatFactor,
    smartFeeNokPerYear: (fee ?? 0) * vatFactor,
    smartFeeOnceNok: b.smartFeeOnceNok * vatFactor,
    basis,
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
  const t2 = (x: AnalysisResult["before"]["total"]) => ({ loadKwh: r0(x.loadKwh), pvKwh: r0(x.pvKwh), selfKwh: r0(x.selfKwh), importKwh: r0(x.importKwh), exportKwh: r0(x.exportKwh), netto: r0(x.cost.netto) });
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
    offerLabel: res.offerLabel,
    vat: p.input.vatFactor && p.input.vatFactor !== 1 ? "inkl" : "eks",
    meters: res.meters.map((m) => ({ id: m.id, label: m.label, tariff: m.tariff, before: t2(m.before), after: t2(m.after), saving: r0(m.before.cost.netto - m.after.cost.netto) })),
    charging: res.charging ? { kwh: r0(res.charging.kwh), solarKwh: r0(res.charging.solarKwh), effektleddIncrease: r0(res.charging.effektleddIncrease) } : null,
    battery: res.battery ? batterySummary(res.battery) : null,
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

const ecoDto = (e: NonNullable<AnalysisResult["economy"]>[number]) => ({
  name: e.name,
  kraftGrowth: e.kraftGrowth,
  npv: e.result.npv == null ? null : r0(e.result.npv),
  pvOfOperations: r0(e.result.pvOfOperations),
  paybackYears: e.result.paybackYears == null ? null : r2(e.result.paybackYears),
  discountedPaybackYears: e.result.discountedPaybackYears == null ? null : r2(e.result.discountedPaybackYears),
  irr: e.result.irr == null ? null : r2(e.result.irr * 100) / 100,
  irrNote: e.result.irrNote ?? null,
  firstYearNet: r0(e.result.firstYearNet),
  rows: e.result.rows.map((x) => ({ year: x.year, netto: r0(x.netto), akkumulert: x.akkumulert == null ? null : r0(x.akkumulert), utskifting: r0(x.utskifting), drift: r0(x.drift) })),
});

/** Batteridelen av kundesammendraget: alternativene, forskjellene og batteritall. */
function batterySummary(b: NonNullable<AnalysisResult["battery"]>) {
  const smart = b.alternatives.find((a) => a.key === "smart")!;
  const sol = b.alternatives.find((a) => a.key === "sol")!;
  const stats = (r: typeof smart.result) => {
    const x = r.total.battery!;
    return {
      chargeKwh: r0(x.chargeKwh),
      solarChargeKwh: r0(x.solarChargeKwh),
      gridChargeKwh: r0(x.gridChargeKwh),
      dischargeKwh: r0(x.dischargeKwh),
      toLoadKwh: r0(x.toLoadKwh),
      toGridKwh: r0(x.toGridKwh),
      lossKwh: r0(x.lossKwh),
      auxKwh: r0(x.auxKwh),
      cycles: r2(x.cycles),
      avgChargePrice: x.gridChargeKwh > 0.5 ? r2(x.gridChargeCostNok / x.gridChargeKwh) : null,
      avgSellPrice: x.toGridKwh > 0.5 ? r2(x.toGridRevenueNok / x.toGridKwh) : null,
    };
  };
  return {
    label: b.label,
    investmentNok: b.investmentNok == null ? null : r0(b.investmentNok),
    config: {
      usableKwh: r2(b.config.usableKwh),
      powerKw: r2(b.config.chargeKw),
      dischargeKw: r2(b.config.dischargeKw),
      sharedAcKw: b.config.sharedAcKw ?? null,
      roundTrip: r2(b.config.roundTrip),
      reserveShare: r2(b.config.reserveShare),
      gridCharge: b.config.gridCharge,
      gridExport: b.config.gridExport,
      lifeYears: b.config.lifeYears,
    },
    alternatives: b.alternatives.map((a) => ({
      key: a.key,
      name: a.name,
      energySaving: r0(a.savings.total),
      savings: Object.fromEntries(Object.entries(a.savings).map(([k, v]) => [k, r0(v)])),
      opex: r0(a.opex),
      net: r0(a.net),
      importKwh: r0(a.result.total.importKwh),
      exportKwh: r0(a.result.total.exportKwh),
      selfKwh: r0(a.result.total.selfKwh),
      costAfter: r0(a.result.total.cost.netto),
      investmentNok: a.investmentNok == null ? null : r0(a.investmentNok),
      economy: a.economy?.map(ecoDto) ?? null,
      battery: a.result.total.battery ? stats(a.result) : null,
    })),
    value: { grunn: r0(b.value.grunn), smart: r0(b.value.smart), smartFee: r0(b.value.smartFee) },
    perfectForesightNet: r0(b.perfectForesightNet),
    months: smart.result.months.map((m, i) => {
      const s0 = sol.result.months[i];
      return {
        month: m.month,
        gain: r0((s0?.cost.netto ?? 0) - m.cost.netto),
        chargeKwh: r0(m.battery?.chargeKwh ?? 0),
        gridChargeKwh: r0(m.battery?.gridChargeKwh ?? 0),
        dischargeKwh: r0(m.battery?.dischargeKwh ?? 0),
        toGridKwh: r0(m.battery?.toGridKwh ?? 0),
        lossKwh: r0(m.battery?.lossKwh ?? 0),
        cycles: r2(m.battery?.cycles ?? 0),
        peakBeforeKw: r2(s0?.peakKw ?? 0),
        peakAfterKw: r2(m.peakKw),
      };
    }),
    day: b.day ? { date: b.day.date, hours: b.day.hours.map((h) => ({ hour: h.hour, price: r2(h.price), soc: r2(h.soc), battery: r2(h.battery), load: r2(h.load), pv: r2(h.pv) })) } : null,
  };
}

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
  const save = async (series: TimeSeries, meteringPointId = p.input.meteringPoint.id) => {
    const [row] = await tx<{ id: string }[]>`
      insert into calc.business_series (analysis_id, metering_point_id, kind, origin, status, resolution_min, start_utc, intervals, sum_kwh, values_f64, provenance, active, created_by)
      values (${analysisId}, ${meteringPointId}, ${series.kind}, 'låst', ${series.provenance.status}, ${series.resolutionMin},
              ${new Date(series.startUtc)}, ${series.values.length}, ${series.kind === "pris" ? 0 : seriesSum(series.values)},
              ${toBytes(series.values)}, ${asJson(series.provenance)}, false, ${userId})
      returning id`;
    return row.id;
  };
  const productionId = p.meta.productionSeriesId ?? (await save(p.input.production));
  const spotId = await save(p.input.spot);
  // Andre målere: produksjon kopieres (forbruket er en lagret serie eller en profil fra innstillingene)
  const others = [];
  for (const m of p.input.otherMeters ?? [])
    others.push({ id: m.id, production: m.production ? await save(m.production, m.id) : null, load: p.meta.otherMeters.find((x) => x.id === m.id)?.loadSeriesId ?? null });
  const summary = customerSummary(res, p, null);
  const [run] = await tx<{ id: string }[]>`
    insert into calc.business_runs (analysis_id, quote_version_id, estimate_id, engine_version, input_hash, input_snapshot, result, locked_at, created_by)
    values (${analysisId}, ${quoteVersionId}, ${estimateId}, ${res.engineVersion}, ${res.inputHash},
      ${asJson({ settings: p.settings, meta: p.meta, series: { load: p.meta.loadSeriesId, production: productionId, spot: spotId, otherMeters: others } })},
      ${asJson(summary)}, now(), ${userId})
    returning id`;
  return { ...summary, runId: run.id };
}

export function notCalculated(reason: string) {
  return { status: "ikke beregnet" as const, reason, at: fmtLocal(Date.now()) };
}
