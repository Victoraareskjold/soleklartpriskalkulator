// Elavgift (forbruksavgift på elektrisk kraft) per periode og avgiftsstatus, øre/kWh eks. mva.
// Satsene endres gjennom året, så analysen bruker satsen som gjaldt i hver time.
// Vedlikeholdes manuelt. Ukjent sats for en periode gir et synlig avvik – aldri en stille 0.

export type TaxStatus = "ordinær" | "redusert" | "fritak" | "ukjent";

export interface TaxPeriod {
  from: string; // ISO-dato, lokal, inkl.
  to: string; // ISO-dato, lokal, inkl.
  orePerKwh: number;
  source: string;
}

const ORDINAER: TaxPeriod[] = [
  { from: "2024-01-01", to: "2024-03-31", orePerKwh: 9.51, source: "Vedtatte satser 2024 (gjengitt i nettselskapenes tariffark)" },
  { from: "2024-04-01", to: "2024-12-31", orePerKwh: 16.44, source: "Vedtatte satser 2024 (gjengitt i nettselskapenes tariffark)" },
  { from: "2025-01-01", to: "2025-03-31", orePerKwh: 9.79, source: "Finansdepartementet, avgiftssatser 2025" },
  { from: "2025-04-01", to: "2025-09-30", orePerKwh: 16.93, source: "Finansdepartementet, avgiftssatser 2025" },
  { from: "2025-10-01", to: "2025-12-31", orePerKwh: 12.53, source: "Stortingets endring fra 1.10.2025 (forskrift 2025-06-20-1183)" },
  { from: "2026-01-01", to: "2026-12-31", orePerKwh: 7.13, source: "Skatteetaten, satser 2026" },
];

const REDUSERT: TaxPeriod[] = [
  // 2024: ikke funnet i offentlig kilde ennå. 0,58 øre gjenskaper Ålesund-fakturaene for 2024 (avledet).
  { from: "2024-01-01", to: "2024-12-31", orePerKwh: 0.58, source: "Avledet fra kostnadsrapport 2024 (ikke offentlig kilde)" },
  { from: "2026-01-01", to: "2026-12-31", orePerKwh: 0.6, source: "Skatteetaten, satser 2026" },
];

/** Satsene som dekker [fromDay, toDay]. missing = dager uten kjent sats. */
export function taxPeriods(status: TaxStatus, fromDay: string, toDay: string): { periods: TaxPeriod[]; missing: string | null } {
  if (status === "fritak") return { periods: [{ from: fromDay, to: toDay, orePerKwh: 0, source: "Fritak (oppgitt)" }], missing: null };
  const table = status === "redusert" ? REDUSERT : ORDINAER;
  const periods = table.filter((p) => p.to >= fromDay && p.from <= toDay);
  // Finn første dag uten dekning
  let cursor = fromDay;
  for (const p of [...periods].sort((a, b) => a.from.localeCompare(b.from))) {
    if (p.from > cursor) break;
    if (p.to >= cursor) cursor = nextDay(p.to);
  }
  return { periods, missing: cursor <= toDay ? cursor : null };
}

function nextDay(d: string) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** Sats på en lokal dato, eller null hvis ingen periode dekker den. */
export function rateOn(periods: TaxPeriod[], day: string): number | null {
  for (const p of periods) if (p.from <= day && day <= p.to) return p.orePerKwh;
  return null;
}
