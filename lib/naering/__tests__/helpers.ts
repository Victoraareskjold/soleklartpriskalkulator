import type { TimeSeries } from "../types";
import type { BuyAgreement, SellAgreement, Taxes } from "../tariff";
import { HOUR, hoursInYear, osloLocalToUtc, osloParts } from "../time";
import { existsSync } from "node:fs";

export const VEDLEGG =
  process.env.VEDLEGG_DIR ?? "../../Downloads/Victor_naeringsanalyse_vedlegg_2026-10-21/";
export const hasVedlegg = existsSync(VEDLEGG + "01_Forbruk_Aalesund_2024.xlsx");

export function yearSeries(year: number, kind: TimeSeries["kind"], f: (t: number, i: number) => number): TimeSeries {
  const start = osloLocalToUtc(year, 1, 1, 0)[0];
  const n = hoursInYear(year);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = f(start + i * HOUR, i);
  return {
    kind,
    startUtc: start,
    resolutionMin: 60,
    values,
    unit: kind === "pris" ? "NOK/kWh" : "kWh",
    provenance: { status: "antatt", source: "test" },
  };
}

/** Grov solkurve: 0 om natten, topp midt på dagen, større om sommeren. */
export function fakePv(year: number, kwp: number) {
  return yearSeries(year, "produksjon", (t) => {
    const p = osloParts(t);
    const doy = (p.month - 1) * 30.4 + p.day;
    const len = 6 + 12 * Math.sin((Math.PI * doy) / 365) ** 2;
    const x = (p.hour + 0.5 - (13 - len / 2)) / len;
    return x > 0 && x < 1 ? kwp * 0.7 * Math.sin(Math.PI * x) * (0.3 + 0.7 * Math.sin((Math.PI * doy) / 365) ** 2) : 0;
  });
}

export const buy: BuyAgreement = { type: "spot", markupOrePerKwh: 2, monthlyFeeNok: 49, provenance: { status: "antatt", source: "test" } };
export const sell: SellAgreement = { type: "spot", deductionOrePerKwh: 2, provenance: { status: "antatt", source: "test" } };
export const taxes: Taxes = { elavgiftOrePerKwh: 0.58, status: "redusert", provenance: { status: "antatt", source: "test" } };
