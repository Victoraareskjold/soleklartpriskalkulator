import { z } from "zod";
import { requireAccess, requireAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

const schema = z
  .object({
    name: z.string().trim().min(1),
    unit: z.string().trim().min(1),
    unitConfirmed: z.boolean(),
    active: z.boolean(),
  })
  .partial();

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const input = await body(req, schema);

  const [workType] = await sql<{ team_id: string }[]>`select team_id from calc.work_types where id = ${id}`;
  if (!workType) throw new HttpError(404, "Fant ikke arbeidstypen", "NOT_FOUND");
  requireAdmin(access, workType.team_id);

  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.unit !== undefined) changes.unit = input.unit;
  if (input.unitConfirmed !== undefined) changes.unit_confirmed = input.unitConfirmed;
  if (input.active !== undefined) changes.active = input.active;
  if (!Object.keys(changes).length) return { ok: true };

  await sql`update calc.work_types set ${sql(changes)} where id = ${id}`;
  return { ok: true };
});
