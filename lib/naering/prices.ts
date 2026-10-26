// Spotpriser fra hvakosterstrommen.no (ENTSO-E omregnet til NOK, uten mva. og strømstøtte).
// Én fil per døgn: /api/v1/prices/YYYY/MM-DD_NO3.json. Fra okt. 2025 kan døgnet ha 96 kvarterspriser.

import type { TimeSeries } from "./types";
import { HOUR, MIN, fmtLocal } from "./time";

export interface HvaKosterRow {
  NOK_per_kWh: number;
  EUR_per_kWh: number;
  EXR: number;
  time_start: string; // ISO med offset
  time_end: string;
}

export const PRICE_AREAS = ["NO1", "NO2", "NO3", "NO4", "NO5"] as const;
export type PriceArea = (typeof PRICE_AREAS)[number];

export function hvaKosterUrl(area: PriceArea, y: number, m: number, d: number) {
  const z = (n: number) => String(n).padStart(2, "0");
  return `https://www.hvakosterstrommen.no/api/v1/prices/${y}/${z(m)}-${z(d)}_${area}.json`;
}

/**
 * Bygger en timeprisserie (NOK/kWh eks. mva.) på UTC-aksen.
 * Kvarterspriser slås sammen til timesnitt – loggføres, fordi forbruket i trinn 1 regnes per time.
 */
export function buildPriceSeries(rows: HvaKosterRow[], area: PriceArea): { series: TimeSeries; notes: string[] } {
  const notes: string[] = [];
  const parsed = rows
    .map((r) => ({ s: Date.parse(r.time_start), e: Date.parse(r.time_end), p: r.NOK_per_kWh }))
    .sort((a, b) => a.s - b.s);
  if (!parsed.length) throw new Error("Ingen prisdata");
  const start = Math.floor(parsed[0].s / HOUR) * HOUR;
  const end = Math.ceil(parsed[parsed.length - 1].e / HOUR) * HOUR;
  const n = (end - start) / HOUR;
  const sum = new Float64Array(n);
  const wt = new Float64Array(n);
  let quarter = 0;
  for (const r of parsed) {
    const len = (r.e - r.s) / MIN;
    if (len < 60) quarter++;
    const i = Math.floor((r.s - start) / HOUR);
    sum[i] += r.p * len;
    wt[i] += len;
  }
  const values = new Float64Array(n);
  const holes: string[] = [];
  for (let i = 0; i < n; i++) {
    values[i] = wt[i] >= 59.99 ? sum[i] / wt[i] : NaN;
    if (Number.isNaN(values[i])) holes.push(fmtLocal(start + i * HOUR));
  }
  if (quarter) notes.push(`${quarter} kvarterspriser er slått sammen til timesnitt (forbruket regnes per time i trinn 1).`);
  if (holes.length) notes.push(`${holes.length} timer mangler pris (f.eks. ${holes.slice(0, 2).join(", ")}). Beregningen stopper hvis de trengs.`);
  return {
    series: {
      kind: "pris",
      startUtc: start,
      resolutionMin: 60,
      values,
      unit: "NOK/kWh",
      provenance: {
        status: "målt",
        source: `hvakosterstrommen.no ${area} (ENTSO-E, omregnet til NOK, eks. mva.)`,
        period: { from: fmtLocal(start), to: fmtLocal(end - HOUR) },
      },
    },
    notes,
  };
}
