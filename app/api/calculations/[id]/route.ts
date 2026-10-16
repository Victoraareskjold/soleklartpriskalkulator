import { z } from "zod";
import { draftSchema } from "@/lib/quote/draft";
import { assertLeadAndEstimate, loadCalculation, toCalculationDto, type CalculationRow } from "@/lib/quote/access";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

/** Kalkylen med utkast og liste over lagrede versjoner. */
export const GET = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const { calculation } = await loadCalculation(access, id);
  const versions = await sql`
    select id, version, parent_version_id as "parentVersionId", estimate_id as "estimateId", engine_version as "engineVersion",
           total_ex_vat_ore::int as "totalExVatOre", total_inc_vat_ore::int as "totalIncVatOre", created_at as "createdAt"
    from calc.quote_versions where calculation_id = ${id} order by version desc`;
  return { ...toCalculationDto(calculation), versions };
});

const updateSchema = z.object({
  lockVersion: z.number().int().positive(),
  draft: draftSchema,
  estimateId: uuid.nullable().optional(),
});

/** Lagre utkastet. lockVersion hindrer at to som jobber samtidig overskriver hverandre. */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const { calculation } = await loadCalculation(access, id);
  const input = await body(req, updateSchema);
  const estimateId = input.estimateId === undefined ? calculation.estimate_id : input.estimateId;
  if (estimateId !== calculation.estimate_id) await assertLeadAndEstimate(calculation.installer_group_id, calculation.lead_id, estimateId);

  const [row] = await sql<CalculationRow[]>`
    update calc.calculations
    set draft_input = ${asJson(input.draft)}, title = ${input.draft.projectName || calculation.title},
        customer_type = ${input.draft.customerType}, estimate_id = ${estimateId}, lock_version = lock_version + 1, updated_by = ${access.userId}
    where id = ${id} and lock_version = ${input.lockVersion}
    returning *`;
  if (!row) throw new HttpError(409, "Kalkylen er endret av noen andre. Last inn på nytt.", "CONFLICT");
  return toCalculationDto(row);
});
