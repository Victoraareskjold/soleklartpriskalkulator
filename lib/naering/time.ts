// Tid: lagres i UTC, vises og tolkes i Europe/Oslo.
// Håndterer sommertid (døgn med 23/25 timer) og skuddår uten egne tabeller.

export const TZ = "Europe/Oslo";
export const HOUR = 3_600_000;
export const MIN = 60_000;

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 1 = mandag … 7 = søndag */
  weekday: number;
}

// Cache per time-start: kalles 8784+ ganger per analyse.
const partsCache = new Map<number, LocalParts>();

export function osloParts(utcMs: number): LocalParts {
  const key = Math.floor(utcMs / MIN);
  const hit = partsCache.get(key);
  if (hit) return hit;
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const r: LocalParts = {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    weekday: WEEKDAYS[p.weekday],
  };
  if (partsCache.size > 500_000) partsCache.clear();
  partsCache.set(key, r);
  return r;
}

/** Offset Oslo − UTC i ms for et gitt UTC-tidspunkt (3600000 vinter, 7200000 sommer). */
export function osloOffsetMs(utcMs: number): number {
  const p = osloParts(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(utcMs / MIN) * MIN;
}

/**
 * Lokal veggklokketid → mulige UTC-tidspunkt.
 *  - 1 kandidat: vanlig
 *  - 0 kandidater: tiden finnes ikke (vår: 02:00–02:59 hoppes over)
 *  - 2 kandidater: tiden finnes to ganger (høst: 02:00–02:59), tidligst først
 */
export function osloLocalToUtc(y: number, mo: number, d: number, h: number, mi = 0): number[] {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const out: number[] = [];
  for (const off of [2 * HOUR, 1 * HOUR]) {
    const cand = naive - off;
    const p = osloParts(cand);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) out.push(cand);
  }
  return out.sort((a, b) => a - b);
}

export function fmtLocal(utcMs: number): string {
  const p = osloParts(utcMs);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}`;
}

/** Start av lokalt kalenderår i UTC. */
export function osloYearStartUtc(year: number): number {
  return osloLocalToUtc(year, 1, 1, 0)[0];
}

export function isLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Antall timer i et lokalt kalenderår (8760/8784 – uavhengig av sommertid). */
export function hoursInYear(y: number) {
  return isLeap(y) ? 8784 : 8760;
}
