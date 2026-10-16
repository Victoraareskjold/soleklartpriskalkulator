import { z } from "zod";
import { requireAccess, requireInstallerAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { markupGroup, percent } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({ markupGroup, percent: percent(1000).nullable() });

/** Sett påslag for én påslagsgruppe. null fjerner påslaget. */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const installer = await requireInstallerAdmin(access, id);
  const input = await body(req, schema);
  const [group] = await sql`select 1 from calc.markup_groups where team_id = ${installer.teamId} and code = ${input.markupGroup}`;
  if (!group) throw new HttpError(400, "Ukjent påslagsgruppe", "BAD_REQUEST");

  if (input.percent === null) {
    await sql`delete from calc.installer_markups where installer_group_id = ${installer.id} and markup_group = ${input.markupGroup}`;
  } else {
    await sql`
      insert into calc.installer_markups (installer_group_id, markup_group, percent, updated_by)
      values (${installer.id}, ${input.markupGroup}, ${input.percent}, ${access.userId})
      on conflict (installer_group_id, markup_group)
      do update set percent = excluded.percent, updated_by = excluded.updated_by`;
  }
  return { ok: true };
});
