import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { loadAnalysis } from "@/lib/server/naering/store";

export const OPTIONS = preflight;

/** Slår en serie av eller på. Verdiene endres aldri; en låst kopi brukes i sendte tilbud. */
export const PATCH = handler<{ id: string; seriesId: string }>(async (req, { id, seriesId }) => {
  const access = await requireAccess(req);
  await loadAnalysis(access, id);
  const input = await body(req, z.object({ active: z.boolean() }));
  return sql.begin(async (tx) => {
    const [s] = await tx<{ metering_point_id: string; kind: string }[]>`
      select metering_point_id, kind from calc.business_series where id = ${seriesId} and analysis_id = ${id} and origin <> 'låst'`;
    if (!s) throw new HttpError(404, "Fant ikke serien", "NOT_FOUND");
    if (input.active)
      await tx`update calc.business_series set active = false
               where analysis_id = ${id} and metering_point_id = ${s.metering_point_id} and kind = ${s.kind} and active`;
    await tx`update calc.business_series set active = ${input.active} where id = ${seriesId}`;
    return { id: seriesId, active: input.active };
  });
});
