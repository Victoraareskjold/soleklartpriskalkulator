import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { analysisDto, loadAnalysis, type AnalysisRow } from "@/lib/server/naering/store";
import { settingsSchema } from "@/lib/naering/settings";

export const OPTIONS = preflight;

/** Lagrer innstillingene. lockVersion hindrer at to som redigerer samtidig overskriver hverandre. */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  await loadAnalysis(access, id);
  const input = await body(req, z.object({ lockVersion: z.number().int().positive(), settings: settingsSchema }));
  const [row] = await sql<AnalysisRow[]>`
    update calc.business_analyses
    set settings = ${asJson(input.settings)}, lock_version = lock_version + 1, updated_by = ${access.userId}
    where id = ${id} and lock_version = ${input.lockVersion}
    returning *`;
  if (!row) throw new HttpError(409, "Analysen er endret av noen andre. Last inn på nytt.", "CONFLICT");
  return analysisDto(row);
});
