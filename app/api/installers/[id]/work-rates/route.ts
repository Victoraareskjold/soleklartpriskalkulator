import { z } from "zod";
import { requireAccess, requireInstallerAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({ workTypeId: uuid, price: kroner.nullable() });

/** Sett installatørens sats for en arbeidstype. null fjerner satsen. */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const installer = await requireInstallerAdmin(access, id);
  const input = await body(req, schema);

  const [workType] = await sql`select 1 from calc.work_types where id = ${input.workTypeId} and team_id = ${installer.teamId}`;
  if (!workType) throw new HttpError(404, "Fant ikke arbeidstypen", "NOT_FOUND");

  if (input.price === null) {
    await sql`delete from calc.installer_work_rates where installer_group_id = ${installer.id} and work_type_id = ${input.workTypeId}`;
  } else {
    await sql`
      insert into calc.installer_work_rates (installer_group_id, work_type_id, price_ore, updated_by)
      values (${installer.id}, ${input.workTypeId}, ${input.price}, ${access.userId})
      on conflict (installer_group_id, work_type_id)
      do update set price_ore = excluded.price_ore, updated_by = excluded.updated_by`;
  }
  return { ok: true };
});
