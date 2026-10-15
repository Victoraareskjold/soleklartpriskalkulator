import { z } from "zod";
import { requireAccess, requireAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z
  .object({
    name: z.string().trim().min(1),
    unit: z.string().trim().min(1),
    price: kroner,
    attachmentUrl: z.url().nullable(),
    supplierId: uuid,
    categoryId: uuid,
    active: z.boolean(),
  })
  .partial();

/** Endre produkt. Lagrede tilbud påvirkes ikke (de har sin egen kopi av prisen). */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const input = await body(req, schema);

  const [product] = await sql<{ team_id: string }[]>`select team_id from calc.products where id = ${id}`;
  if (!product) throw new HttpError(404, "Fant ikke produktet", "NOT_FOUND");
  requireAdmin(access, product.team_id);

  const changes: Record<string, unknown> = { updated_by: access.userId };
  if (input.name !== undefined) changes.name = input.name;
  if (input.unit !== undefined) changes.unit = input.unit;
  if (input.attachmentUrl !== undefined) changes.attachment_url = input.attachmentUrl;
  if (input.supplierId !== undefined) changes.supplier_id = input.supplierId;
  if (input.categoryId !== undefined) changes.category_id = input.categoryId;
  if (input.active !== undefined) changes.active = input.active;
  if (input.price !== undefined) {
    changes.price_ore = input.price;
    changes.price_updated_at = new Date();
  }

  await sql`update calc.products set ${sql(changes)} where id = ${id}`;
  return { ok: true };
});
