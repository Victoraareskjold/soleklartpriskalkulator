import { createHash } from "node:crypto";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { handler, HttpError, preflight } from "@/lib/server/http";
import { loadAnalysis } from "@/lib/server/naering/store";
import { ImportError, readWorkbookBuffer } from "@/lib/naering/import/read";
import { candidateSummary, detect } from "@/lib/naering/import/detect";

export const OPTIONS = preflight;
export const maxDuration = 30;

/**
 * Laster opp en fil (rå bytes i body, filnavn i X-File-Name). Originalen lagres urørt med hash.
 * Svaret er forslaget til tolkning – ingenting brukes i beregningen før det er bekreftet (import).
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  await loadAnalysis(access, id);
  const fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "").slice(0, 200);
  if (!fileName) throw new HttpError(400, "Filnavn mangler", "BAD_REQUEST");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.byteLength) throw new HttpError(400, "Tom fil", "BAD_REQUEST");

  let summary: ReturnType<typeof candidateSummary>;
  try {
    summary = candidateSummary(detect(readWorkbookBuffer(buf, fileName)));
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(422, e.message, "IMPORT");
    throw e;
  }
  if (!summary.candidates.length)
    throw new HttpError(422, "Fant ingen tidsserier i filen (trenger en kolonne med dato/tid og minst ett døgn med verdier).", "IMPORT");

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const [row] = await sql<{ id: string; created_at: Date }[]>`
    insert into calc.business_files (analysis_id, file_name, sha256, size_bytes, content, detected, created_by)
    values (${id}, ${fileName}, ${sha256}, ${buf.byteLength}, ${Buffer.from(buf)}, ${asJson(summary)}, ${access.userId})
    returning id, created_at`;
  return { file: { id: row.id, fileName, sizeBytes: buf.byteLength, sha256, createdAt: row.created_at }, ...summary };
});
