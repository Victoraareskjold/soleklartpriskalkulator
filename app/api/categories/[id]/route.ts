import { requireAccess, requireAdmin } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { categoryPatchSchema } from "@/lib/server/schemas";

export const OPTIONS = preflight;

/** Endre kategori. Regler (rolle, påslag, mengde, støtte) arves av underkategoriene. */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const [category] = await sql<{ team_id: string; parent_id: string | null }[]>`
    select team_id, parent_id from calc.categories where id = ${id}`;
  if (!category) throw new HttpError(404, "Fant ikke kategorien", "NOT_FOUND");
  requireAdmin(access, category.team_id);
  const input = await body(req, categoryPatchSchema);

  const rules: Record<string, unknown> = {};
  if (input.productKind !== undefined) rules.product_kind = input.productKind;
  if (input.markupGroup !== undefined) rules.markup_group = input.markupGroup;
  if (input.quantityRule !== undefined) rules.quantity_rule = input.quantityRule;
  if (input.supportEligible !== undefined) rules.support_eligible = input.supportEligible;
  if (category.parent_id && Object.keys(rules).length) {
    throw new HttpError(400, "Regler settes på hovedkategorien og arves av underkategoriene", "BAD_REQUEST");
  }

  await sql.begin(async (tx) => {
    if (input.name !== undefined) await tx`update calc.categories set name = ${input.name} where id = ${id}`;
    if (Object.keys(rules).length) {
      await tx`update calc.categories set ${sql(rules)} where id = ${id} or parent_id = ${id}`;
    }
  });
  return { ok: true };
});
