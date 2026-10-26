import "server-only";
// Databasetilgang for næringsanalysen. Tilgang sjekkes alltid via leadens installatør.
import { requireInstallerAccess, type Access } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { settingsSchema, type BusinessSettings } from "@/lib/naering/settings";
import type { QualityReport, TimeSeries, Provenance } from "@/lib/naering/types";

export interface AnalysisRow {
  id: string;
  team_id: string;
  installer_group_id: string;
  lead_id: string;
  settings: unknown;
  lock_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SeriesRow {
  id: string;
  analysis_id: string;
  metering_point_id: string;
  kind: TimeSeries["kind"];
  origin: string;
  status: Provenance["status"];
  resolution_min: 15 | 60;
  start_utc: Date;
  intervals: number;
  sum_kwh: string;
  values_f64?: Uint8Array;
  quality: QualityReport | null;
  provenance: Provenance;
  source_file_id: string | null;
  mapping: unknown;
  active: boolean;
  created_at: Date;
}

export async function leadInstaller(access: Access, leadId: string) {
  const [lead] = await sql<{ installer_group_id: string; address: string | null; company: string | null }[]>`
    select installer_group_id, address, company from public.leads where id = ${leadId}`;
  if (!lead) throw new HttpError(404, "Fant ikke leaden", "NOT_FOUND");
  const installer = await requireInstallerAccess(access, lead.installer_group_id);
  return { installer, lead };
}

export async function loadAnalysis(access: Access, id: string) {
  const [row] = await sql<AnalysisRow[]>`select * from calc.business_analyses where id = ${id}`;
  if (!row) throw new HttpError(404, "Fant ikke næringsanalysen", "NOT_FOUND");
  await requireInstallerAccess(access, row.installer_group_id).catch(() => {
    throw new HttpError(404, "Fant ikke næringsanalysen", "NOT_FOUND");
  });
  return row;
}

export const parseSettings = (raw: unknown): BusinessSettings => settingsSchema.parse(raw ?? {});

export const analysisDto = (a: AnalysisRow) => ({
  id: a.id,
  leadId: a.lead_id,
  installerGroupId: a.installer_group_id,
  settings: parseSettings(a.settings),
  lockVersion: a.lock_version,
  updatedAt: a.updated_at,
});


// ---------------------------------------------------------------- serier

export const toBytes = (v: Float64Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBytes = (b: Uint8Array) => {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float64Array(copy.buffer);
};

export function rowToSeries(r: SeriesRow): TimeSeries {
  if (!r.values_f64) throw new Error("Serien er hentet uten verdier");
  return {
    kind: r.kind,
    startUtc: new Date(r.start_utc).getTime(),
    resolutionMin: r.resolution_min,
    values: fromBytes(r.values_f64),
    unit: r.kind === "pris" ? "NOK/kWh" : "kWh",
    provenance: r.provenance,
    meterId: r.metering_point_id,
  };
}

export const seriesDto = (r: SeriesRow) => ({
  id: r.id,
  meteringPointId: r.metering_point_id,
  kind: r.kind,
  origin: r.origin,
  status: r.status,
  resolutionMin: r.resolution_min,
  startUtc: r.start_utc,
  intervals: r.intervals,
  sumKwh: Number(r.sum_kwh),
  quality: r.quality,
  provenance: r.provenance,
  sourceFileId: r.source_file_id,
  active: r.active,
  createdAt: r.created_at,
});

const META = sql`id, analysis_id, metering_point_id, kind, origin, status, resolution_min, start_utc, intervals, sum_kwh,
  quality, provenance, source_file_id, mapping, active, created_at`;

export async function listSeries(analysisId: string) {
  return sql<SeriesRow[]>`
    select ${META} from calc.business_series
    where analysis_id = ${analysisId} and origin <> 'låst'
    order by created_at desc`;
}

export async function activeSeries(analysisId: string, meteringPointId: string, kind: TimeSeries["kind"]) {
  const [row] = await sql<SeriesRow[]>`
    select ${META}, values_f64 from calc.business_series
    where analysis_id = ${analysisId} and metering_point_id = ${meteringPointId} and kind = ${kind} and active and origin <> 'låst'
    order by created_at desc limit 1`;
  return row ?? null;
}

export function seriesSum(v: Float64Array) {
  let s = 0;
  for (const x of v) if (Number.isFinite(x)) s += x;
  return s;
}
