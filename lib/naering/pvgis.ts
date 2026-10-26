// Solproduksjon per takflate fra PVGIS, som timeserie (ikke bare årssum).
//
// To API-versjoner med ulikt format – adapteren holder dem adskilt og lagrer versjonen:
//  • v5.3  GET re.jrc.ec.europa.eu/api/v5_3/seriescalc?pvcalculation=1   (værår t.o.m. 2023)
//      outputs.hourly[].P = effekt i W, time = "YYYYMMDD:HHMM" i UTC (minuttet er en forskyvning
//      innen timen, ikke intervallstart). Energi i timen = P/1000 kWh.
//  • v6    GET …/api/v6/performance/broadband   (værår 2014–2025 ifølge Asbjørn/release notes)
//      Feltnavn og enheter er IKKE verifisert mot et faktisk svar ennå – parseren kontrollerer
//      seg selv mot svarets egen årssum og nekter å gjette.
//
// Retning: vi bruker asimut fra nord (180 = sør). v5 «aspect» = asimut − 180. v6 «surface_orientation» = asimut.

import type { TimeSeries } from "./types";
import { HOUR, fmtLocal, osloLocalToUtc, osloParts, hoursInYear, isLeap } from "./time";

export interface RoofSurface {
  id: string;
  kwp: number;
  tiltDeg: number;
  azimuthDeg: number; // 180 = sør
  lossPct: number; // systemtap ekskl. det PVGIS selv modellerer
  /** Målepunktet flaten er koblet til. */
  meteringPointId: string;
}

export type PvgisVersion = "v5_3" | "v6";

export function pvgisUrl(v: PvgisVersion, lat: number, lon: number, s: RoofSurface, year: number) {
  if (v === "v5_3") {
    const q = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      peakpower: String(s.kwp),
      loss: String(s.lossPct),
      angle: String(s.tiltDeg),
      aspect: String(s.azimuthDeg - 180),
      pvcalculation: "1",
      startyear: String(year),
      endyear: String(year),
      outputformat: "json",
    });
    return `https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?${q}`;
  }
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    "peak-power": String(s.kwp),
    surface_tilt: String(s.tiltDeg),
    surface_orientation: String(s.azimuthDeg),
    system_efficiency: String(1 - s.lossPct / 100),
    // Hent fra lokal årsstart (23:00 UTC året før) så aksen dekker hele det norske kalenderåret
    start_time: new Date(osloLocalToUtc(year, 1, 1, 0)[0]).toISOString().slice(0, 19),
    end_time: new Date(osloLocalToUtc(year + 1, 1, 1, 0)[0] - 1000).toISOString().slice(0, 19),
    timezone: "UTC",
    frequency: "Hourly",
    analysis: "Advanced",
    statistics: "true",
    angle_output_units: "Degrees",
  });
  return `https://photovoltaic-geographic-information-system.ec.europa.eu/api/v6/performance/broadband?${q}`;
}

export interface ParsedPv {
  startUtc: number;
  kwh: Float64Array;
  notes: string[];
}

export function parseV53(json: unknown): ParsedPv {
  const rows = (json as { outputs?: { hourly?: { time: string; P: number }[] } })?.outputs?.hourly;
  if (!Array.isArray(rows) || !rows.length) throw new Error("PVGIS v5.3: fant ikke outputs.hourly");
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11)); // time-start, minutter droppes
  const start = t(rows[0].time);
  const kwh = new Float64Array(rows.length).fill(NaN);
  for (const r of rows) {
    const i = (t(r.time) - start) / HOUR;
    kwh[i] = r.P / 1000; // W i en time → kWh
  }
  return { startUtc: start, kwh, notes: ["PVGIS v5.3: P (W) omregnet til kWh per time; tid i UTC."] };
}

export function parseV6(raw: unknown, requestedStartUtc: number): ParsedPv {
  type V6 = { photovoltaic_power?: unknown; results?: { photovoltaic_power?: unknown }; photovoltaic_energy?: number | { value?: number } };
  const json = raw as V6 | null;
  const p = (json?.photovoltaic_power ?? json?.results?.photovoltaic_power) as number[] | { values?: number[] } | undefined;
  const arr: number[] | undefined = Array.isArray(p) ? p : Array.isArray(p?.values) ? p.values : undefined;
  const pe = json?.photovoltaic_energy;
  if (!arr) throw new Error("PVGIS v6: fant ikke photovoltaic_power i svaret – formatet må kontrolleres");
  const energyTotal = Number(typeof pe === "object" ? pe?.value : pe);
  const sumW = arr.reduce((a, b) => a + (Number(b) || 0), 0);
  const notes = ["PVGIS v6: photovoltaic_power tolket som effekt i W per time (uverifisert)."];
  // Selvkontroll: hvis svaret oppgir total energi (Wh), må summen av timeeffekter matche.
  if (Number.isFinite(energyTotal) && energyTotal > 0) {
    const ratio = sumW / energyTotal;
    if (Math.abs(ratio - 1) > 0.02 && Math.abs(ratio - 1000) > 20)
      throw new Error(`PVGIS v6: sum effekt (${sumW.toFixed(0)}) stemmer ikke med oppgitt energi (${energyTotal}). Enhet uklar – stopper.`);
    notes.push(`Kontrollert mot svarets oppgitte energi (forhold ${ratio.toFixed(3)}).`);
  } else notes.push("Svaret oppga ikke total energi – enheten er ikke selvkontrollert.");
  return { startUtc: requestedStartUtc, kwh: Float64Array.from(arr, (w) => Number(w) / 1000), notes };
}

/**
 * Legger produksjonen fra et værår inn på analyseårets kalender.
 * Samme måned/dag/time; 29. feb hentes fra 28. feb når væråret ikke er skuddår.
 * Resultatet merkes alltid som simulert («beregnet»), og som «tilpasset» når årene er ulike.
 */
export function alignToYear(pv: ParsedPv, weatherYear: number, targetYear: number): { startUtc: number; kwh: Float64Array; notes: string[] } {
  const notes = [...pv.notes];
  const tStart = osloLocalToUtc(targetYear, 1, 1, 0)[0];
  const n = hoursInYear(targetYear);
  const out = new Float64Array(n);
  let night0 = 0;
  for (let i = 0; i < n; i++) {
    const lp = osloParts(tStart + i * HOUR);
    const { month } = lp;
    let { day } = lp;
    if (month === 2 && day === 29 && !isLeap(weatherYear)) day = 28;
    // Samme lokale veggklokketid i væråret (UTC-time for den lokale timen)
    const c = osloLocalToUtc(weatherYear, month, day, lp.hour);
    const src = c.length ? c[0] : osloLocalToUtc(weatherYear, month, day, lp.hour + 1)[0];
    const j = Math.round((src - pv.startUtc) / HOUR);
    const v = j >= 0 && j < pv.kwh.length ? pv.kwh[j] : NaN;
    if (Number.isNaN(v)) {
      // Utenfor PVGIS-perioden: kun akseptabelt i mørke timer (vinternatt rundt nyttår)
      if (lp.hour >= 20 || lp.hour <= 5) {
        out[i] = 0;
        night0++;
      } else throw new Error(`Mangler PVGIS-verdi for ${fmtLocal(tStart + i * HOUR)}`);
    } else out[i] = v;
  }
  if (night0) notes.push(`${night0} nattetimer utenfor PVGIS-perioden satt til 0 (mørkt).`);
  if (weatherYear !== targetYear) notes.push(`Værår ${weatherYear} lagt på kalenderen for ${targetYear} (tilpasset).`);
  return { startUtc: tStart, kwh: out, notes };
}

export function pvSeries(
  surfaces: { surface: RoofSurface; parsed: ParsedPv }[],
  weatherYear: number,
  targetYear: number,
  version: PvgisVersion,
): TimeSeries {
  let total: Float64Array | null = null;
  let start = 0;
  const notes = new Set<string>();
  for (const { parsed } of surfaces) {
    const a = alignToYear(parsed, weatherYear, targetYear);
    a.notes.forEach((x) => notes.add(x));
    start = a.startUtc;
    total = total ?? new Float64Array(a.kwh.length);
    for (let i = 0; i < a.kwh.length; i++) total[i] += a.kwh[i];
  }
  const kwp = surfaces.reduce((s, x) => s + x.surface.kwp, 0);
  return {
    kind: "produksjon",
    startUtc: start,
    resolutionMin: 60,
    values: total!,
    unit: "kWh",
    meterId: surfaces[0]?.surface.meteringPointId,
    provenance: {
      status: "beregnet",
      source: `PVGIS ${version.replace("_", ".")}, ${surfaces.length} takflate(r), ${kwp} kWp, værår ${weatherYear}`,
      period: { from: `${targetYear}-01-01`, to: `${targetYear}-12-31` },
      note: [...notes].join(" "),
    },
  };
}
