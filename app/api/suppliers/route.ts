import { z } from "zod";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

/** Ny leverandør i felles katalog. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, z.object({ name: z.string().trim().min(1, "Navn mangler").max(120) }));
  const [row] = await sql`
    insert into calc.suppliers (team_id, name, sort_order)
    values (${teamId}, ${input.name}, (select coalesce(max(sort_order), 0) + 1 from calc.suppliers where team_id = ${teamId}))
    returning id, name`;
  return row;
});
