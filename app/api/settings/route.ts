import { z } from "zod";
import { validateTiers } from "@/lib/engine";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, percent, tiers } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z
  .object({
    commissionTiers: tiers,
    noPanelCommissionPercent: percent(),
    vatPercent: percent(),
    inverterSizingFactor: z.coerce.number().gt(0, "Må være større enn 0").max(5),
    supportName: z.string().trim().min(1).max(80),
    supportEnabled: z.boolean(),
    supportPercent: percent(),
    supportPerKwp: kroner,
    supportMaxKwp: z.coerce.number().min(0).max(100000),
    supportMax: kroner,
    mountSupportEligible: z.boolean(),
  })
  .partial();

/** Sentrale regler for teamet: provisjon, mva., invertervalg og støtte. Bare feltene som sendes, endres. */
export const PUT = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, schema);

  const columns: Record<string, unknown> = { updated_by: access.userId };
  if (input.noPanelCommissionPercent !== undefined) columns.no_panel_commission_percent = input.noPanelCommissionPercent;
  if (input.vatPercent !== undefined) columns.vat_percent = input.vatPercent;
  if (input.inverterSizingFactor !== undefined) columns.inverter_sizing_factor = input.inverterSizingFactor;
  if (input.supportName !== undefined) columns.support_name = input.supportName;
  if (input.supportEnabled !== undefined) columns.support_enabled = input.supportEnabled;
  if (input.supportPercent !== undefined) columns.support_percent = input.supportPercent;
  if (input.supportPerKwp !== undefined) columns.support_per_kwp_ore = input.supportPerKwp;
  if (input.supportMaxKwp !== undefined) columns.support_max_kwp = input.supportMaxKwp;
  if (input.supportMax !== undefined) columns.support_max_ore = input.supportMax;
  if (input.mountSupportEligible !== undefined) columns.mount_support_eligible = input.mountSupportEligible;

  const sorted = input.commissionTiers ? validateTiers(input.commissionTiers, "commissionTiers") : null;
  if (sorted?.some((t) => t.min < 1)) throw new HttpError(400, "Provisjonstrinn starter på minst 1 panel", "BAD_REQUEST");

  await sql.begin(async (tx) => {
    await tx`insert into calc.settings (team_id) values (${teamId}) on conflict (team_id) do nothing`;
    await tx`update calc.settings set ${sql(columns)} where team_id = ${teamId}`;
    if (sorted) {
      await tx`delete from calc.commission_tiers where team_id = ${teamId}`;
      for (const tier of sorted) {
        await tx`
          insert into calc.commission_tiers (team_id, from_panels, to_panels, percent)
          values (${teamId}, ${tier.min}, ${tier.max}, ${Number(tier.percent)})`;
      }
    }
  });
  return { ok: true };
});
