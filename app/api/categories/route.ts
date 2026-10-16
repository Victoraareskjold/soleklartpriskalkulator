import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { categorySchema } from "@/lib/server/schemas";

export const OPTIONS = preflight;



/** Ny produktkategori, f.eks. «DC-ladere». */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, categorySchema);

  let { productKind: kind, markupGroup: group, quantityRule, supportEligible } = input;
  if (input.parentId) {
    const [parent] = await sql<{ product_kind: string; markup_group: string; quantity_rule: string; support_eligible: boolean }[]>`
      select product_kind, markup_group, quantity_rule, support_eligible from calc.categories
      where id = ${input.parentId} and team_id = ${teamId} and parent_id is null`;
    if (!parent) throw new HttpError(400, "Ugyldig hovedkategori", "BAD_REQUEST");
    kind = parent.product_kind as typeof kind;
    group = parent.markup_group;
    quantityRule = parent.quantity_rule as typeof quantityRule;
    supportEligible = parent.support_eligible;
  }

  const [row] = await sql`
    insert into calc.categories (team_id, parent_id, name, product_kind, markup_group, quantity_rule, support_eligible, sort_order)
    values (${teamId}, ${input.parentId ?? null}, ${input.name}, ${kind}, ${group}, ${quantityRule}, ${supportEligible},
            (select coalesce(max(sort_order), 0) + 1 from calc.categories where team_id = ${teamId}))
    returning id`;
  return { id: row.id };
});
