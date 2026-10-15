import { z } from "zod";
import { requireAccess, requireAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({
  name: z.string().trim().min(1, "Navn mangler"),
  supplierId: uuid,
  categoryId: uuid,
  unit: z.string().trim().min(1).default("stk"),
  price: kroner,
  attachmentUrl: z.url().nullable().optional(),
});

/** Nytt produkt i felles katalog. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, schema);

  const [supplier] = await sql<{ team_id: string }[]>`select team_id from calc.suppliers where id = ${input.supplierId}`;
  if (!supplier) throw new HttpError(404, "Fant ikke leverandøren", "NOT_FOUND");
  requireAdmin(access, supplier.team_id);

  const [product] = await sql`
    insert into calc.products (team_id, supplier_id, category_id, name, unit, price_ore, attachment_url, updated_by)
    select ${supplier.team_id}, ${input.supplierId}, c.id, ${input.name}, ${input.unit}, ${input.price},
           ${input.attachmentUrl ?? null}, ${access.userId}
    from calc.categories c
    where c.id = ${input.categoryId} and c.team_id = ${supplier.team_id}
    returning id`;
  if (!product) throw new HttpError(400, "Ugyldig kategori", "BAD_REQUEST");
  return { id: product.id };
});
