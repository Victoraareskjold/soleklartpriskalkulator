import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { loadAnalysis, seriesDto, seriesSum, toBytes, type SeriesRow } from "@/lib/server/naering/store";
import { readWorkbookBuffer } from "@/lib/naering/import/read";
import { detect } from "@/lib/naering/import/detect";
import { normalize } from "@/lib/naering/import/normalize";

export const OPTIONS = preflight;
export const maxDuration = 30;

const schema = z.object({
  candidateId: z.string().min(1).max(120),
  kind: z.enum(["forbruk", "produksjon"]),
  unit: z.enum(["Wh", "kWh", "MWh", "W", "kW", "ukjent"]).optional(),
  convention: z.enum(["start", "slutt", "auto"]).default("auto"),
  meteringPointId: z.string().max(40).default("mp1"),
  /** false = bare forhåndskontroll, true = lagre som aktiv serie */
  confirm: z.boolean().default(false),
});

/**
 * Tolker én kolonne i en opplastet fil som forbruk eller produksjon.
 * confirm=false gir datakontrollen (periode, oppløsning, sum, sommertid, hull …) uten å lagre.
 * confirm=true lagrer serien og gjør den aktiv for målepunktet; tidligere serie av samme type beholdes, men blir inaktiv.
 */
export const POST = handler<{ id: string; fileId: string }>(async (req, { id, fileId }) => {
  const access = await requireAccess(req);
  await loadAnalysis(access, id);
  const input = await body(req, schema);
  const [file] = await sql<{ file_name: string; content: Uint8Array }[]>`
    select file_name, content from calc.business_files where id = ${fileId} and analysis_id = ${id}`;
  if (!file) throw new HttpError(404, "Fant ikke filen", "NOT_FOUND");

  const cand = detect(readWorkbookBuffer(new Uint8Array(file.content), file.file_name)).candidates.find((c) => c.id === input.candidateId);
  if (!cand) throw new HttpError(404, "Fant ikke kolonnen i filen", "NOT_FOUND");
  const { series, report } = normalize(cand, {
    kind: input.kind,
    unit: input.unit,
    convention: input.convention,
    sourceLabel: `${file.file_name}, ${cand.id}${cand.meterId ? ` (målepunkt ${cand.meterId})` : ""}`,
  });
  if (!input.confirm) return { report, preview: true };

  const mapping = { candidateId: cand.id, kind: input.kind, unit: input.unit ?? cand.unitGuess, convention: input.convention, meterId: cand.meterId ?? null };
  const saved = await sql.begin(async (tx) => {
    await tx`
      update calc.business_series set active = false
      where analysis_id = ${id} and metering_point_id = ${input.meteringPointId} and kind = ${input.kind} and active`;
    const [row] = await tx<SeriesRow[]>`
      insert into calc.business_series (analysis_id, metering_point_id, kind, origin, status, resolution_min, start_utc, intervals,
        sum_kwh, values_f64, quality, provenance, source_file_id, mapping, active, created_by)
      values (${id}, ${input.meteringPointId}, ${input.kind}, 'opplasting', ${series.provenance.status}, ${series.resolutionMin},
        ${new Date(series.startUtc)}, ${series.values.length}, ${seriesSum(series.values)}, ${toBytes(series.values)},
        ${asJson(report)}, ${asJson(series.provenance)}, ${fileId}, ${asJson(mapping)}, true, ${access.userId})
      returning id, analysis_id, metering_point_id, kind, origin, status, resolution_min, start_utc, intervals, sum_kwh,
        quality, provenance, source_file_id, mapping, active, created_at`;
    return row;
  });
  return { report, series: seriesDto(saved) };
});
