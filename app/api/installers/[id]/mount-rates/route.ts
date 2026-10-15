import { z } from "zod";
import { requireAccess, requireInstallerAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({
  roofTypeId: uuid,
  productId: uuid.nullable(),
  price: kroner.nullable(),
});

/** Monteringspris per panel og festesystem for én taktype. price null fjerner taktypen. */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const installer = await requireInstallerAdmin(access, id);
  const input = await body(req, schema);

  if (input.productId) {
    const [product] = await sql`
      select 1 from calc.products p join calc.categories c on c.id = p.category_id
      where p.id = ${input.productId} and p.team_id = ${installer.teamId} and c.product_kind = 'feste'`;
    if (!product) throw new HttpError(400, "Produktet er ikke et festesystem", "BAD_REQUEST");
  }

  if (input.price === null) {
    await sql`delete from calc.installer_mount_rates where installer_group_id = ${installer.id} and roof_type_id = ${input.roofTypeId}`;
  } else {
    await sql`
      insert into calc.installer_mount_rates (installer_group_id, roof_type_id, product_id, price_ore, updated_by)
      values (${installer.id}, ${input.roofTypeId}, ${input.productId}, ${input.price}, ${access.userId})
      on conflict (installer_group_id, roof_type_id)
      do update set product_id = excluded.product_id, price_ore = excluded.price_ore, updated_by = excluded.updated_by`;
  }
  return { ok: true };
});
