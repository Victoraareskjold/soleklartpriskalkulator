// Standard forbruksprofiler når kundens timeverdier mangler (datanivå 1 og 2).
// Parametrene under er FORELØPIGE antakelser i prototypen og må kvalitetssikres
// (gjerne mot åpne Elhub-data og egne målte kunder). Alt som lages her merkes «antatt».

import type { TimeSeries } from "./types";
import { HOUR, hoursInYear, osloLocalToUtc, osloParts } from "./time";

export type BusinessType = "kontor" | "butikk" | "lager" | "verksted" | "landbruk" | "døgnkontinuerlig";

interface ProfileParams {
  label: string;
  open: [number, number]; // standard driftstid [fra, til) lokal time
  /** Last utenfor driftstid relativt til driftstid (grunnlast) */
  base: number;
  /** Last i helg relativt til hverdag i driftstid */
  weekend: number;
  /** Vinter/sommer-forskjell: 0.3 → januar ~30 % over snittet, juli ~30 % under */
  season: number;
}

export const PROFILES: Record<BusinessType, ProfileParams> = {
  kontor: { label: "Kontor", open: [7, 17], base: 0.35, weekend: 0.35, season: 0.3 },
  butikk: { label: "Butikk", open: [9, 21], base: 0.3, weekend: 0.85, season: 0.2 },
  lager: { label: "Lager", open: [6, 16], base: 0.45, weekend: 0.5, season: 0.35 },
  verksted: { label: "Verksted/industri", open: [6, 15], base: 0.3, weekend: 0.3, season: 0.25 },
  landbruk: { label: "Landbruk", open: [5, 20], base: 0.6, weekend: 0.9, season: 0.2 },
  døgnkontinuerlig: { label: "Døgnkontinuerlig drift", open: [0, 24], base: 1, weekend: 0.95, season: 0.15 },
};

export interface ProfileInput {
  type: BusinessType;
  year: number;
  annualKwh: number;
  /** Overstyr driftstid */
  openHours?: [number, number];
  /**
   * Driftstider per dagtype. Satt dag = åpen i tidsrommet (full drift), null = stengt (grunnlast).
   * Mangler = man–fre åpent (openHours) og virksomhetstypens helgefaktor.
   */
  schedule?: { weekdays: [number, number] | null; saturday: [number, number] | null; sunday: [number, number] | null; closedMonths?: number[] } | null;
  /** Datanivå 2: kjent månedsforbruk (12 verdier). Profilen skaleres til hver måned. */
  monthlyKwh?: number[];
}

/** Bevegelige og faste helligdager (behandles som søndag). */
export function norwegianHolidays(y: number): Set<string> {
  // Påskedag (anonym gregoriansk algoritme)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = Date.UTC(y, month - 1, day);
  const D = 86400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return new Set([
    `${y}-01-01`, `${y}-05-01`, `${y}-05-17`, `${y}-12-25`, `${y}-12-26`,
    iso(easter - 3 * D), iso(easter - 2 * D), iso(easter), iso(easter + D),
    iso(easter + 39 * D), iso(easter + 49 * D), iso(easter + 50 * D),
  ]);
}

export function standardProfile(input: ProfileInput): TimeSeries {
  const p = PROFILES[input.type];
  const [from, to] = input.openHours ?? p.open;
  const start = osloLocalToUtc(input.year, 1, 1, 0)[0];
  const n = hoursInYear(input.year);
  const holidays = norwegianHolidays(input.year);
  const z = (x: number) => String(x).padStart(2, "0");
  const v = new Float64Array(n);
  const months = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const lp = osloParts(start + i * HOUR);
    months[i] = lp.month - 1;
    const doy = (Date.UTC(lp.year, lp.month - 1, lp.day) - Date.UTC(lp.year, 0, 1)) / 86400_000;
    const seasonal = 1 + p.season * Math.cos((2 * Math.PI * (doy - 15)) / 365);
    const holiday = holidays.has(`${lp.year}-${z(lp.month)}-${z(lp.day)}`);
    const weekend = lp.weekday >= 6 || holiday;
    let level: number;
    const sch = input.schedule;
    if (sch) {
      // Egne driftstider per dagtype: helligdag regnes som søndag
      const day = holiday || lp.weekday === 7 ? sch.sunday : lp.weekday === 6 ? sch.saturday : sch.weekdays;
      if (!day) level = p.base;
      else {
        const inOpen = lp.hour >= day[0] && lp.hour < day[1];
        const edge = lp.hour === day[0] - 1 || lp.hour === day[1];
        level = inOpen ? 1 : edge ? (1 + p.base) / 2 : p.base;
      }
    } else {
      // Myk overgang: 1 time opp- og nedkjøring rundt driftstiden
      const inOpen = lp.hour >= from && lp.hour < to;
      const edge = lp.hour === from - 1 || lp.hour === to;
      level = inOpen ? 1 : edge ? (1 + p.base) / 2 : p.base;
      if (weekend) level = p.base + (level - p.base) * p.weekend;
    }
    // Måneder med redusert drift (f.eks. fellesferie): bare grunnlast
    if (input.schedule?.closedMonths?.includes(lp.month)) level = p.base;
    v[i] = level * seasonal;
  }
  // Skaler: årssum eller hver måned
  if (input.monthlyKwh?.length === 12) {
    const ms = new Float64Array(12);
    for (let i = 0; i < n; i++) ms[months[i]] += v[i];
    for (let i = 0; i < n; i++) v[i] *= input.monthlyKwh[months[i]] / ms[months[i]];
  } else {
    const s = v.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) v[i] *= input.annualKwh / s;
  }
  return {
    kind: "forbruk",
    startUtc: start,
    resolutionMin: 60,
    values: v,
    unit: "kWh",
    provenance: {
      status: "antatt",
      source: `Standardprofil ${p.label.toLowerCase()}, ${input.schedule ? scheduleText(input.schedule) : `driftstid ${z(from)}–${z(to)}`}${input.monthlyKwh ? ", skalert til oppgitt månedsforbruk" : ""}`,
      period: { from: `${input.year}-01-01`, to: `${input.year}-12-31` },
      note: input.monthlyKwh
        ? "Månedssummer fra kunden, fordeling over døgnet er anslått."
        : `Årsforbruk ${Math.round(input.annualKwh).toLocaleString("nb-NO")} kWh, fordeling over året og døgnet er anslått.`,
    },
  };
}

export function scheduleText(s: NonNullable<ProfileInput["schedule"]>) {
  const z = (x: number) => String(x).padStart(2, "0");
  const f = (d: [number, number] | null) => (d ? `${z(d[0])}–${z(d[1])}` : "stengt");
  const M = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
  return `hverdager ${f(s.weekdays)}, lørdag ${f(s.saturday)}, søndag/helligdag ${f(s.sunday)}${s.closedMonths?.length ? `, redusert drift ${s.closedMonths.map((m) => M[m - 1]).join("/")}` : ""}`;
}

/** Ladeprofil: energi per dag fordelt jevnt i ladevinduet, begrenset av ladeeffekten. Antatt. */
export function chargingProfile(
  year: number,
  chargers: { label: string; count: number; kw: number; kwhPerDay: number; window: [number, number]; days: "hverdager" | "alle" }[],
): TimeSeries {
  const start = osloLocalToUtc(year, 1, 1, 0)[0];
  const n = hoursInYear(year);
  const holidays = norwegianHolidays(year);
  const z = (x: number) => String(x).padStart(2, "0");
  const v = new Float64Array(n);
  for (const c of chargers) {
    const [a, b] = c.window[1] > c.window[0] ? c.window : [c.window[0], c.window[1] + 24];
    const hoursOpen = b - a;
    const perHour = Math.min(c.kw, c.kwhPerDay / Math.max(1, hoursOpen)) * c.count;
    for (let i = 0; i < n; i++) {
      const lp = osloParts(start + i * HOUR);
      const off = lp.weekday >= 6 || holidays.has(`${lp.year}-${z(lp.month)}-${z(lp.day)}`);
      if (c.days === "hverdager" && off) continue;
      const h = lp.hour < a && b > 24 ? lp.hour + 24 : lp.hour;
      if (h >= a && h < b) v[i] += perHour;
    }
  }
  return {
    kind: "forbruk",
    startUtc: start,
    resolutionMin: 60,
    values: v,
    unit: "kWh",
    provenance: {
      status: "antatt",
      source: `Ladeprofil: ${chargers.map((c) => `${c.count} × ${c.kw} kW, ${c.kwhPerDay} kWh/dag kl. ${z(c.window[0])}–${z(c.window[1])} (${c.days})`).join("; ")}`,
      period: { from: `${year}-01-01`, to: `${year}-12-31` },
      note: "Ladingen er fordelt jevnt i ladevinduet (anslag, ikke målt).",
    },
  };
}
