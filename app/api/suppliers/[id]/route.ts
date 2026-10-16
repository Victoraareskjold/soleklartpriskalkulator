import { z } from "zod";
import { requireAccess, requireAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

const schema = z.object({ name: z.string().trim().min(1).max(120), active: z.boolean() }).partial();

/** Gi nytt navn eller skjul en leverandør. */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const [supplier] = await sql<{ team_id: string }[]>`select team_id from calc.suppliers where id = ${id}`;
  if (!supplier) throw new HttpError(404, "Fant ikke leverandøren", "NOT_FOUND");
  requireAdmin(access, supplier.team_id);
  const input = await body(req, schema);
  if (!Object.keys(input).length) return { ok: true };
  await sql`update calc.suppliers set ${sql(input)} where id = ${id}`;
  return { ok: true };
});
