import { z } from "zod";
import { validateTiers } from "@/lib/engine";
import { requireAccess, requireInstallerAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";
import { tiers } from "@/lib/server/schemas";

export const OPTIONS = preflight;

/** Erstatter alle volumtrinn for installatøren. Overlapp avvises (samme regel som motoren). */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const installer = await requireInstallerAdmin(access, id);
  const input = await body(req, z.object({ tiers }));
  const sorted = validateTiers(input.tiers, "tiers");

  await sql.begin(async (tx) => {
    await tx`delete from calc.volume_tiers where installer_group_id = ${installer.id}`;
    for (const tier of sorted) {
      await tx`
        insert into calc.volume_tiers (installer_group_id, from_panels, to_panels, percent)
        values (${installer.id}, ${tier.min}, ${tier.max}, ${Number(tier.percent)})`;
    }
  });
  return { ok: true };
});
