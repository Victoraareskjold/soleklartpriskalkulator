import { z } from "zod";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";
import { workGroup } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({
  group: workGroup,
  name: z.string().trim().min(1, "Navn mangler"),
  unit: z.string().trim().min(1, "Enhet mangler"),
});

/** Ny felles arbeidstype. Blir tilgjengelig for alle; satsen avtales per installatør. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, schema);

  const [row] = await sql`
    insert into calc.work_types (team_id, grp, name, unit, unit_confirmed, sort_order)
    values (${teamId}, ${input.group}, ${input.name}, ${input.unit}, true,
            (select coalesce(max(sort_order), 0) + 1 from calc.work_types where team_id = ${teamId} and grp = ${input.group}))
    returning id`;
  return { id: row.id };
});
