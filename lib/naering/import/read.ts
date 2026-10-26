// Leser regneark (XLSX) og CSV til rå rader. Ingen tolkning her – bare celler.
//
// Egen, liten XLSX-leser i stedet for et bibliotek:
//  • ingen avhengighet med kjente sårbarheter ved lesing av opplastede filer
//  • tåler eksportene fra nettselskapsportaler (x:-prefiks og ugyldig xmlns som openpyxl avviser)
//  • leser bare lagrede celleverdier: formler, makroer og eksterne koblinger kjøres aldri
// Gamle .xls (binærformat) støttes ikke: brukeren får beskjed om å lagre som .xlsx eller .csv.

import { inflateRawSync } from "node:zlib";

export interface RawSheet {
  name: string;
  rows: unknown[][];
}
export interface RawWorkbook {
  fileName: string;
  sheets: RawSheet[];
}

export const MAX_BYTES = 10 * 1024 * 1024;
const MAX_UNZIPPED = 200 * 1024 * 1024;

export class ImportError extends Error {}

export function readWorkbookBuffer(buf: Uint8Array, fileName: string): RawWorkbook {
  if (buf.byteLength > MAX_BYTES) throw new ImportError(`Filen er større enn ${MAX_BYTES / 1024 / 1024} MB`);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt"))
    return { fileName, sheets: [{ name: "CSV", rows: parseCsv(decodeText(buf)) }] };
  if (lower.endsWith(".xls"))
    throw new ImportError("Gamle .xls-filer støttes ikke ennå. Åpne filen i Excel og lagre som .xlsx eller .csv.");
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm"))
    throw new ImportError(`Ukjent filtype: ${fileName} (støtter .xlsx og .csv)`);
  return { fileName, sheets: readXlsx(buf) };
}

function decodeText(buf: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  // Norske CSV-eksporter er ofte Windows-1252: ugyldig UTF-8 gir erstatningstegn
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8;
}

// ---------------------------------------------------------------- zip

function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ImportError("Filen er ikke et gyldig Excel-dokument (.xlsx)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new ImportError("Skadet Excel-fil");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    // Les bare det vi trenger
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    total += size;
    if (total > MAX_UNZIPPED) throw new ImportError("Excel-filen pakker ut til for mye data");
    const lh = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(lh, lh + compSize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(size, 1) + 1024 })));
    else throw new ImportError(`Ukjent komprimering i Excel-filen (${method})`);
  }
  return out;
}

// ---------------------------------------------------------------- xml

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m),
  );
const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`))?.[1];
/** Elementer med valgfritt navneromsprefiks (x:c, c). */
const el = (tag: string) => new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>)`, "g");
const texts = (xml: string) => [...xml.matchAll(el("t"))].map((m) => unescape(m[2] ?? "")).join("");

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)?.[0] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf: Uint8Array): RawSheet[] {
  const files = unzip(buf);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? new TextDecoder("utf-8").decode(f) : "";
  };
  const shared = [...text("xl/sharedStrings.xml").matchAll(el("si"))].map((m) => texts(m[2] ?? ""));
  const rels = new Map<string, string>();
  for (const m of text("xl/_rels/workbook.xml.rels").matchAll(el("Relationship"))) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const sheets: RawSheet[] = [];
  for (const m of text("xl/workbook.xml").matchAll(el("sheet"))) {
    const name = unescape(attr(m[1], "name") ?? `Ark${sheets.length + 1}`);
    const path = rels.get(attr(m[1], "id") ?? "") ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = text(path);
    if (!xml) continue;
    const rows: unknown[][] = [];
    for (const r of xml.matchAll(el("row"))) {
      const ri = Number(attr(r[1], "r") ?? rows.length + 1) - 1;
      const row: unknown[] = [];
      for (const c of (r[2] ?? "").matchAll(el("c"))) {
        const ref = attr(c[1], "r");
        const ci = ref ? colIndex(ref) : row.length;
        const t = attr(c[1], "t");
        const inner = c[2] ?? "";
        const v = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        let value: unknown = "";
        if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = texts(inner);
        else if (t === "str" || t === "e") value = v != null ? unescape(v) : "";
        else if (t === "b") value = v === "1";
        else if (v != null && v !== "") value = Number(v);
        while (row.length < ci) row.push("");
        row[ci] = value;
      }
      while (rows.length < ri) rows.push([]);
      rows[ri] = row;
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new ImportError("Fant ingen regneark i filen");
  return sheets;
}

// ---------------------------------------------------------------- csv

/** CSV med automatisk skilletegn (; , tab) og desimalkomma. */
export function parseCsv(text: string): unknown[][] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const sample = lines.slice(0, 20).join("\n");
  const delim = [";", "\t", ","].map((d) => [d, sample.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return lines.map((l) =>
    l.split(delim).map((c) => {
      const s = c.trim().replace(/^"|"$/g, "");
      const n = s.replace(/[\s ]/g, "");
      if (/^-?\d+([.,]\d+)?$/.test(n)) return Number(n.replace(",", "."));
      return s;
    }),
  );
}
