import { z } from "zod";
import { draftSchema } from "@/lib/quote/draft";
import { assertLeadAndEstimate, toCalculationDto, type CalculationRow } from "@/lib/quote/access";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

/** Kalkyler for en lead (?leadId=) eller en installatør (?installerGroupId=), nyeste først. */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const params = new URL(req.url).searchParams;
  const leadId = params.get("leadId");
  let installerGroupId = params.get("installerGroupId");

  if (leadId) {
    const [lead] = await sql<{ installer_group_id: string }[]>`select installer_group_id from public.leads where id = ${leadId}`;
    if (!lead) throw new HttpError(404, "Fant ikke leaden", "NOT_FOUND");
    installerGroupId = lead.installer_group_id;
  }
  const installer = await requireInstallerAccess(access, installerGroupId);

  const rows = await sql<(CalculationRow & { latest_version: number | null; latest_total_ex_vat_ore: number | null; latest_total_inc_vat_ore: number | null })[]>`
    select c.*, v.version as latest_version,
           v.total_ex_vat_ore::int as latest_total_ex_vat_ore, v.total_inc_vat_ore::int as latest_total_inc_vat_ore
    from calc.calculations c
    left join lateral (
      select version, total_ex_vat_ore, total_inc_vat_ore from calc.quote_versions
      where calculation_id = c.id order by version desc limit 1
    ) v on true
    where c.installer_group_id = ${installer.id}
      and (${leadId}::uuid is null or c.lead_id = ${leadId})
    order by c.updated_at desc
    limit 100`;

  return {
    calculations: rows.map((r) => ({
      ...toCalculationDto(r),
      draft: undefined,
      latestVersion: r.latest_version,
      latestTotalExVatOre: r.latest_total_ex_vat_ore,
      latestTotalIncVatOre: r.latest_total_inc_vat_ore,
    })),
  };
});

const createSchema = z.object({
  installerGroupId: uuid,
  leadId: uuid.nullable().optional(),
  estimateId: uuid.nullable().optional(),
  draft: draftSchema,
});

/** Nytt kalkyleutkast. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, createSchema);
  const installer = await requireInstallerAccess(access, input.installerGroupId);
  await assertLeadAndEstimate(installer.id, input.leadId ?? null, input.estimateId ?? null);

  const [row] = await sql<CalculationRow[]>`
    insert into calc.calculations (team_id, installer_group_id, lead_id, estimate_id, title, customer_type, draft_input, created_by)
    values (${installer.teamId}, ${installer.id}, ${input.leadId ?? null}, ${input.estimateId ?? null},
            ${input.draft.projectName || "Kalkyle"}, ${input.draft.customerType}, ${sql.json(input.draft)}, ${access.userId})
    returning *`;
  return toCalculationDto(row);
});
