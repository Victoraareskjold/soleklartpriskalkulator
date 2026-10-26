// Gjør en gjenkjent kolonne om til en normalisert tidsserie (UTC, kWh per intervall)
// og lager datakontrollen som vises før serien tas i bruk.
// Originalverdier endres aldri; alt vi fyller inn eller fjerner logges.

import type { CandidateSeries, EnergyUnit, PowerUnit, Stamp } from "./detect";
import { stampKey } from "./detect";
import type { QualityIssue, QualityReport, SeriesKind, TimeSeries } from "../types";
import { fmtLocal, hoursInYear, MIN, osloLocalToUtc, osloParts } from "../time";

export interface NormalizeOptions {
  kind: SeriesKind;
  /** Bekreftet enhet. «ukjent» → antas kWh, med advarsel. */
  unit?: EnergyUnit | PowerUnit | "ukjent";
  /** Står tidsstempelet ved starten eller slutten av intervallet? */
  convention?: "start" | "slutt" | "auto";
  /** Fyll hull på inntil N intervaller med interpolasjon (merkes som estimert). 0 = aldri. */
  maxFillIntervals?: number;
  sourceLabel?: string;
}

export interface NormalizeResult {
  series: TimeSeries;
  report: QualityReport;
}

function detectResolution(rows: { stamp: Stamp }[]): 15 | 60 {
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(rows.length, 500); i++) {
    const a = rows[i - 1].stamp;
    const b = rows[i].stamp;
    diffs.push((Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi) - Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi)) / MIN);
  }
  diffs.sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)] === 15 ? 15 : 60;
}

function toKwhFactor(unit: string, resMin: number): number {
  switch (unit) {
    case "Wh":
      return 1 / 1000;
    case "MWh":
      return 1000;
    case "kW": // middeleffekt i intervallet
      return resMin / 60;
    case "W":
      return resMin / 60 / 1000;
    default:
      return 1;
  }
}

export function normalize(cand: CandidateSeries, opts: NormalizeOptions): NormalizeResult {
  const issues: QualityIssue[] = [];
  const res = detectResolution(cand.rows);
  const resMs = res * MIN;

  // ---- tidskonvensjon
  let convention = opts.convention ?? "auto";
  if (convention === "auto") {
    const f = cand.rows[0].stamp;
    const l = cand.rows[cand.rows.length - 1].stamp;
    const firstIsOffset = res === 60 ? f.h === 1 && f.mi === 0 : f.h === 0 && f.mi === 15;
    const lastIsMidnight = l.h === 0 && l.mi === 0;
    convention = firstIsOffset && lastIsMidnight ? "slutt" : "start";
    if (convention === "slutt")
      issues.push({
        level: "advarsel",
        code: "TID_SLUTT",
        message: `Første tid er ${f.raw} og siste er ${l.raw}. Tolket som at tiden angir SLUTTEN av intervallet. Bekreft.`,
      });
  }

  // ---- enhet
  let unit = opts.unit ?? cand.unitGuess;
  if (unit === "ukjent") {
    issues.push({
      level: "advarsel",
      code: "ENHET_UKJENT",
      message: "Enhet er ikke oppgitt i filen. Antatt kWh per intervall – må bekreftes før resultatet brukes.",
    });
    unit = "kWh";
  }
  const factor = toKwhFactor(unit, res);

  // ---- plassér radene på UTC-aksen
  const placed: { utc: number; value: number; key: string }[] = [];
  const seen = new Map<string, number>();
  const ambiguous = new Map<string, number[]>(); // label → kandidater
  const dropped: string[] = [];
  let droppedEnergy = 0;

  for (const { stamp, value } of cand.rows) {
    const key = stampKey(stamp);
    let cands: number[];
    if (stamp.utcMs !== undefined) cands = [stamp.utcMs];
    else if (convention === "slutt") {
      // slutt-tid → start = slutt − oppløsning. Midnatt «24:00» skrives som 00:00 neste dag.
      cands = osloLocalToUtc(stamp.y, stamp.mo, stamp.d, stamp.h, stamp.mi).map((t) => t - resMs);
    } else cands = osloLocalToUtc(stamp.y, stamp.mo, stamp.d, stamp.h, stamp.mi);

    if (cands.length === 0) {
      dropped.push(stamp.raw);
      droppedEnergy += value;
      continue;
    }
    const occ = seen.get(key) ?? 0;
    seen.set(key, occ + 1);
    if (cands.length === 2) ambiguous.set(key, cands);
    placed.push({ utc: cands[Math.min(occ, cands.length - 1)], value: value * factor, key });
  }

  if (dropped.length) {
    const zero = Math.abs(droppedEnergy) < 1e-9;
    issues.push({
      level: zero ? "info" : "advarsel",
      code: "SOMMERTID_VAR",
      count: dropped.length,
      examples: dropped.slice(0, 3),
      message: zero
        ? `${dropped.length} tidspunkt finnes ikke i norsk tid (klokka hopper fra 02 til 03 om våren). Radene har verdi 0 og er fjernet.`
        : `${dropped.length} tidspunkt finnes ikke i norsk tid, men har verdi (${droppedEnergy.toFixed(2)}). Filen kan være i fast UTC+1. Kontroller tidssone.`,
    });
  }
  const missingAutumn: string[] = [];
  for (const key of ambiguous.keys()) if ((seen.get(key) ?? 0) < 2) missingAutumn.push(key);
  if (missingAutumn.length)
    issues.push({
      level: "advarsel",
      code: "SOMMERTID_HOST",
      count: missingAutumn.length,
      examples: missingAutumn.slice(0, 3),
      message: `Natten sommertiden slutter har klokka ${missingAutumn[0].slice(11)} to ganger, men filen har den bare én gang. ` +
        `Én time mangler (typisk for eksporter med fast 24-timers døgn). Den mangler i summen fra filen.`,
    });

  // ---- rutenett
  const start = Math.min(...placed.map((p) => p.utc));
  const end = Math.max(...placed.map((p) => p.utc)) + resMs;
  const n = Math.round((end - start) / resMs);
  const values = new Float64Array(n).fill(NaN);
  let dupSame = 0;
  const dupDiff: string[] = [];
  for (const p of placed) {
    const i = Math.round((p.utc - start) / resMs);
    if (Number.isNaN(values[i])) values[i] = p.value;
    else if (Math.abs(values[i] - p.value) < 1e-9) dupSame++;
    else dupDiff.push(p.key);
  }
  if (dupSame) issues.push({ level: "info", code: "DUPLIKAT_LIK", count: dupSame, message: `${dupSame} like duplikater fjernet.` });
  if (dupDiff.length)
    issues.push({
      level: "feil",
      code: "DUPLIKAT_ULIK",
      count: dupDiff.length,
      examples: dupDiff.slice(0, 3),
      message: `${dupDiff.length} tidspunkt har to ulike verdier. Første verdi er brukt – må kontrolleres.`,
    });

  // ---- hull
  const maxFill = opts.maxFillIntervals ?? 2;
  const estimatedIdx: number[] = [];
  const longGaps: string[] = [];
  let missing = 0;
  for (let i = 0; i < n; ) {
    if (!Number.isNaN(values[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Number.isNaN(values[j])) j++;
    const len = j - i;
    missing += len;
    if (len <= maxFill && i > 0 && j < n) {
      // Fyll med gjennomsnitt av samme time døgnet før/etter hvis mulig, ellers lineært.
      for (let k = i; k < j; k++) {
        const per = (24 * 60) / res;
        const a = values[k - per];
        const b = values[k + per];
        values[k] =
          Number.isFinite(a) && Number.isFinite(b)
            ? (a + b) / 2
            : values[i - 1] + ((values[j] - values[i - 1]) * (k - i + 1)) / (len + 1);
        estimatedIdx.push(k);
      }
    } else longGaps.push(`${fmtLocal(start + i * resMs)} (${len} intervaller)`);
    i = j;
  }
  if (estimatedIdx.length)
    issues.push({
      level: "advarsel",
      code: "HULL_FYLT",
      count: estimatedIdx.length,
      examples: estimatedIdx.slice(0, 3).map((k) => fmtLocal(start + k * resMs)),
      message: `${estimatedIdx.length} manglende intervaller er fylt inn med snitt av samme tid døgnet før og etter. Merket som estimert.`,
    });
  if (longGaps.length)
    issues.push({
      level: "feil",
      code: "HULL_LANGE",
      count: longGaps.length,
      examples: longGaps.slice(0, 3),
      message: "Lengre hull er ikke fylt. Serien kan ikke brukes i en årsberegning før hullene er avklart.",
    });

  // ---- tomme celler: aldri null
  const lastStamp = cand.rows[cand.rows.length - 1].stamp;
  const lastKey = stampKey(lastStamp);
  const trailingEmpty = cand.emptyRows.filter((s) => stampKey(s) > lastKey).length;
  const innerEmpty = cand.emptyRows.length - trailingEmpty;
  if (trailingEmpty)
    issues.push({
      level: "info",
      code: "TOMME_SLUTT",
      count: trailingEmpty,
      message: `${trailingEmpty} tidsstempler uten verdi etter siste måling er ignorert (ikke tolket som 0).`,
    });
  if (innerEmpty)
    issues.push({
      level: "advarsel",
      code: "TOMME_INNI",
      count: innerEmpty,
      message: `${innerEmpty} tomme celler inne i perioden er behandlet som manglende, ikke som 0.`,
    });

  // ---- plausibilitet
  let neg = 0;
  let max = -Infinity;
  let maxI = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    sum += v;
    if (v < 0) neg++;
    if (v > max) [max, maxI] = [v, i];
  }
  if (neg && (opts.kind === "forbruk" || opts.kind === "produksjon"))
    issues.push({ level: "advarsel", code: "NEGATIV", count: neg, message: `${neg} negative verdier i en ${opts.kind}sserie.` });
  issues.push({
    level: "info",
    code: "TOPP",
    message: `Høyeste intervall: ${max.toFixed(2)} kWh ${fmtLocal(start + maxI * resMs)}. Effekttopper beholdes som de er.`,
  });
  if (cand.aggregateOf)
    issues.push({
      level: "advarsel",
      code: "AGGREGAT",
      message: `Serien er summen av ${cand.aggregateOf.join(", ")}. Ikke bruk den sammen med målerne den består av.`,
    });

  // ---- forventet antall intervaller (helt kalenderår?)
  const first = osloParts(start);
  const last = osloParts(end - resMs);
  let expected = n;
  if (first.month === 1 && first.day === 1 && first.hour === 0 && last.year === first.year && last.month === 12 && last.day === 31) {
    expected = (hoursInYear(first.year) * 60) / res;
    if (n !== expected)
      issues.push({ level: "feil", code: "AR_UKOMPLETT", message: `Kalenderåret ${first.year} skal ha ${expected} intervaller, filen dekker ${n}.` });
  }

  const series: TimeSeries = {
    kind: opts.kind,
    startUtc: start,
    resolutionMin: res,
    values,
    unit: "kWh",
    estimatedIdx,
    meterId: cand.meterId,
    provenance: {
      status: "målt",
      source: opts.sourceLabel ?? `${cand.id}${cand.meterId ? ` (målepunkt ${cand.meterId})` : ""}`,
      period: { from: fmtLocal(start), to: fmtLocal(end - resMs) },
      note: estimatedIdx.length ? `${estimatedIdx.length} intervaller estimert` : undefined,
    },
  };

  return {
    series,
    report: {
      intervals: n,
      expectedIntervals: expected,
      resolutionMin: res,
      firstLocal: fmtLocal(start),
      lastLocal: fmtLocal(end - resMs),
      sumKwh: sum,
      missing,
      duplicates: dupSame + dupDiff.length,
      estimated: estimatedIdx.length,
      issues,
    },
  };
}
