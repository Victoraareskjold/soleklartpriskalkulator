import { z } from "zod";
import { validateTiers } from "@/lib/engine";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { percent, tiers } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({
  commissionTiers: tiers,
  noPanelCommissionPercent: percent(),
  vatPercent: percent(),
});

/** Soleklart-provisjon og mva. for teamet. */
export const PUT = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, schema);
  const sorted = validateTiers(input.commissionTiers, "commissionTiers");
  if (sorted.some((t) => t.min < 1)) throw new HttpError(400, "Provisjonstrinn starter på minst 1 panel", "BAD_REQUEST");

  await sql.begin(async (tx) => {
    await tx`
      insert into calc.settings (team_id, no_panel_commission_percent, vat_percent, updated_by)
      values (${teamId}, ${input.noPanelCommissionPercent}, ${input.vatPercent}, ${access.userId})
      on conflict (team_id) do update set
        no_panel_commission_percent = excluded.no_panel_commission_percent,
        vat_percent = excluded.vat_percent,
        updated_by = excluded.updated_by`;
    await tx`delete from calc.commission_tiers where team_id = ${teamId}`;
    for (const tier of sorted) {
      await tx`
        insert into calc.commission_tiers (team_id, from_panels, to_panels, percent)
        values (${teamId}, ${tier.min}, ${tier.max}, ${Number(tier.percent)})`;
    }
  });
  return { ok: true };
});
