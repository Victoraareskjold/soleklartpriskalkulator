// Gjenkjenner tidskolonne, verdikolonner, metadata (målepunkt, prisområde, netteier),
// rolle (forbruk/produksjon) og enhet. Gir FORSLAG – selger bekrefter i forhåndskontrollen.

import type { RawSheet, RawWorkbook } from "./read";
import type { SeriesKind } from "../types";

/** Tidsstempel slik det står i filen. utcMs settes bare når filen selv oppgir offset/UTC. */
export interface Stamp {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  utcMs?: number;
  raw: string;
}

export type EnergyUnit = "Wh" | "kWh" | "MWh";
export type PowerUnit = "W" | "kW";

export interface CandidateSeries {
  id: string; // "Målepunktdata!B"
  sheet: string;
  column: number;
  header: string;
  meta: Record<string, string>;
  meterId?: string;
  priceArea?: string;
  gridOwner?: string;
  roleGuess: SeriesKind | "ukjent";
  roleReason: string;
  unitGuess: EnergyUnit | PowerUnit | "ukjent";
  unitReason: string;
  rows: { stamp: Stamp; value: number }[];
  /** Tidsstempler uten tallverdi (tomme celler) – IKKE null */
  emptyRows: Stamp[];
  /** Satt dersom serien er summen av andre serier i samme fil (f.eks. «Soner») */
  aggregateOf?: string[];
}

export interface DetectResult {
  fileName: string;
  candidates: CandidateSeries[];
  notes: string[];
}

// ---------------------------------------------------------------- tidsstempler

const pad = (n: number) => String(n).padStart(2, "0");

export function parseStamp(v: unknown): Stamp | null {
  if (typeof v === "number") {
    // Excel-serienummer (1900-system). 25569 = 1970-01-01. Avrund til hele minutter
    // så flyttallsfeil ikke gir falske hull på ett sekund.
    if (v < 20000 || v > 80000) return null;
    const ms = Math.round(((v - 25569) * 86400_000) / 60_000) * 60_000;
    const dt = new Date(ms);
    return {
      y: dt.getUTCFullYear(),
      mo: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      h: dt.getUTCHours(),
      mi: dt.getUTCMinutes(),
      raw: `${pad(dt.getUTCDate())}.${pad(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
    };
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m: RegExpMatchArray | null;
  // 01-01-2024 00:00  /  01.01.2024 00:00(:00)
  if ((m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/)))
    return { d: +m[1], mo: +m[2], y: +m[3], h: +m[4], mi: +m[5], raw: s };
  // 2024-01-01 00:00(:00) evt. med offset/Z
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/))) {
    const st: Stamp = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], raw: s };
    if (m[6]) st.utcMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${m[6] === "Z" ? "Z" : m[6]}`);
    return st;
  }
  return null;
}

export const stampKey = (s: Stamp) => `${s.y}-${pad(s.mo)}-${pad(s.d)} ${pad(s.h)}:${pad(s.mi)}`;

// ---------------------------------------------------------------- gjenkjenning

const META_KEYS: Record<string, "meterId" | "priceArea" | "gridOwner"> = {
  "målepunkt-id": "meterId",
  "malepunkt-id": "meterId",
  målepunkt: "meterId",
  "metering point": "meterId",
  prisområde: "priceArea",
  netteier: "gridOwner",
};

function guessRole(text: string): [CandidateSeries["roleGuess"], string] {
  const t = text.toLowerCase();
  if (/(produksjon|production|solcelle|pv[ _-]|generation|innmating)/.test(t)) return ["produksjon", `«${text}» tyder på produksjon`];
  if (/(eksport|export|utmating|overskudd)/.test(t)) return ["eksport", `«${text}» tyder på eksport`];
  if (/(forbruk|consumption|uttak|import|last)/.test(t)) return ["forbruk", `«${text}» tyder på forbruk`];
  return ["ukjent", "ingen kolonne- eller arknavn som sier hva serien er"];
}

function guessUnit(text: string): [CandidateSeries["unitGuess"], string] {
  const m = text.match(/\b(MWh|kWh|Wh|kW|W)\b/);
  if (m) return [m[1] as EnergyUnit, `«${m[1]}» står i «${text}»`];
  return ["ukjent", "enhet står ikke i fil- eller kolonnenavn"];
}

function analyseSheet(sheet: RawSheet, fileName: string): CandidateSeries[] {
  const rows = sheet.rows;
  // Finn kolonnen med flest tolkbare tidsstempler (sjekker de tre første)
  let tcol = -1;
  let best = 0;
  for (let c = 0; c < 3; c++) {
    const n = rows.reduce<number>((acc, r) => acc + (parseStamp(r?.[c]) ? 1 : 0), 0);
    if (n > best) [best, tcol] = [n, c];
  }
  if (tcol < 0 || best < 24) return [];

  const firstData = rows.findIndex((r) => parseStamp(r?.[tcol]));
  const header = rows.slice(0, firstData);
  const width = Math.max(...rows.map((r) => r?.length ?? 0));
  const out: CandidateSeries[] = [];

  for (let c = 0; c < width; c++) {
    if (c === tcol) continue;
    const meta: Record<string, string> = {};
    let headerText = "";
    for (const hr of header) {
      const label = String(hr?.[tcol] ?? "").trim();
      const cell = String(hr?.[c] ?? "").trim();
      if (!cell) continue;
      if (label) meta[label] = cell;
      else headerText = cell; // f.eks. sone-navn i toppraden
      if (!label) continue;
    }
    if (!headerText) headerText = String(header[header.length - 1]?.[c] ?? "").trim();

    const data: CandidateSeries["rows"] = [];
    const empty: Stamp[] = [];
    for (let i = firstData; i < rows.length; i++) {
      const st = parseStamp(rows[i]?.[tcol]);
      if (!st) continue;
      const v = rows[i]?.[c];
      if (typeof v === "number" && Number.isFinite(v)) data.push({ stamp: st, value: v });
      else if (v === "" || v == null) empty.push(st);
    }
    if (data.length < 24) continue;

    const cand: CandidateSeries = {
      id: `${sheet.name}!${String.fromCharCode(65 + c)}`,
      sheet: sheet.name,
      column: c,
      header: headerText,
      meta,
      roleGuess: "ukjent",
      roleReason: "",
      unitGuess: "ukjent",
      unitReason: "",
      rows: data,
      emptyRows: empty,
    };
    for (const [k, v] of Object.entries(meta)) {
      const key = META_KEYS[k.toLowerCase()];
      if (key) cand[key] = v;
    }
    // Rolle: kolonne → ark → filnavn. Filnavn som «hourvalues» sier ingenting om rolle.
    for (const src of [headerText, ...Object.values(meta), sheet.name, fileName]) {
      const [r, why] = guessRole(src);
      if (r !== "ukjent") {
        [cand.roleGuess, cand.roleReason] = [r, why];
        break;
      }
    }
    if (cand.roleGuess === "ukjent") cand.roleReason = "ingen kolonne-, ark- eller filnavn sier hva serien er";
    for (const src of [headerText, ...Object.keys(meta), fileName]) {
      const [u, why] = guessUnit(src);
      if (u !== "ukjent") {
        [cand.unitGuess, cand.unitReason] = [u, why];
        break;
      }
    }
    if (cand.unitGuess === "ukjent") cand.unitReason = "enhet står ikke i fil-, ark- eller kolonnenavn";
    out.push(cand);
  }
  return out;
}

/** Marker serier som er summen av en gruppe andre serier (unngå dobbelttelling). */
function markAggregates(cands: CandidateSeries[]) {
  const bySheet = new Map<string, CandidateSeries[]>();
  for (const c of cands) bySheet.set(c.sheet, [...(bySheet.get(c.sheet) ?? []), c]);
  for (const a of cands) {
    for (const [sheet, group] of bySheet) {
      if (sheet === a.sheet || group.length < 2) continue;
      const idx = new Map<string, number>();
      for (const g of group)
        for (const r of g.rows) idx.set(stampKey(r.stamp), (idx.get(stampKey(r.stamp)) ?? 0) + r.value);
      let ok = 0;
      let checked = 0;
      for (const r of a.rows.slice(0, 2000)) {
        const s = idx.get(stampKey(r.stamp));
        if (s === undefined) continue;
        checked++;
        if (Math.abs(s - r.value) < 0.02 + 1e-4 * Math.abs(r.value)) ok++;
      }
      if (checked > 100 && ok / checked > 0.99) a.aggregateOf = group.map((g) => g.id);
    }
  }
}

export function detect(wb: RawWorkbook): DetectResult {
  const candidates = wb.sheets.flatMap((s) => analyseSheet(s, wb.fileName));
  markAggregates(candidates);
  const notes: string[] = [];
  for (const c of candidates)
    if (c.aggregateOf)
      notes.push(`${c.id} («${c.header}») er summen av ${c.aggregateOf.join(", ")} – brukes ikke sammen med disse.`);
  return { fileName: wb.fileName, candidates, notes };
}

/** Lagringsvennlig oversikt over kandidat-seriene (uten selve radene). */
export function candidateSummary(d: DetectResult) {
  return {
    fileName: d.fileName,
    notes: d.notes,
    candidates: d.candidates.map((c) => ({
      id: c.id,
      sheet: c.sheet,
      header: c.header,
      meterId: c.meterId ?? null,
      priceArea: c.priceArea ?? null,
      gridOwner: c.gridOwner ?? null,
      roleGuess: c.roleGuess,
      roleReason: c.roleReason,
      unitGuess: c.unitGuess,
      unitReason: c.unitReason,
      aggregateOf: c.aggregateOf ?? null,
      rows: c.rows.length,
      emptyRows: c.emptyRows.length,
      first: c.rows[0]?.stamp.raw ?? null,
      last: c.rows[c.rows.length - 1]?.stamp.raw ?? null,
      sum: Math.round(c.rows.reduce((a, r) => a + r.value, 0) * 1000) / 1000,
    })),
  };
}

