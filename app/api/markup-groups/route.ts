import { z } from "zod";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

const toCode = (name: string) =>
  name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9æøå_-]/g, "").slice(0, 40);

/**
 * Ny påslagsgruppe, f.eks. «DC-ladere». Hver installatør kan da få eget påslag for gruppen.
 * PUT oppdaterer navnet på en eksisterende gruppe.
 */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, z.object({ name: z.string().trim().min(1, "Navn mangler").max(80) }));
  const code = toCode(input.name);
  if (!code) throw new HttpError(400, "Ugyldig navn", "BAD_REQUEST");
  const [row] = await sql`
    insert into calc.markup_groups (team_id, code, name, sort_order)
    values (${teamId}, ${code}, ${input.name},
            (select coalesce(max(sort_order), 0) + 1 from calc.markup_groups where team_id = ${teamId}))
    returning code, name`;
  return row;
});

export const PUT = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, z.object({ code: z.string().min(1), name: z.string().trim().min(1).max(80) }));
  await sql`update calc.markup_groups set name = ${input.name} where team_id = ${teamId} and code = ${input.code}`;
  return { ok: true };
});
