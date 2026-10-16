import { isAdmin, requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { handler, preflight } from "@/lib/server/http";
import { loadSettings } from "@/lib/server/settings";

export const OPTIONS = preflight;

/**
 * Katalog, avtaler og regler for én installatør: alt som trengs for å bygge en kalkyle.
 * GET /api/catalog?installerGroupId=...
 * Beløp i øre. Prosent som tall. Skjulte produkter/arbeidstyper er med (active=false), så de kan vises igjen.
 * mountRates har én rad per taktype (priceOre null = ikke avtalt).
 */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const installerGroupId = new URL(req.url).searchParams.get("installerGroupId");
  const installer = await requireInstallerAccess(access, installerGroupId);

  const [markupGroups, suppliers, categories, products, markups, workTypes, mountRates, volumeTiers, commissionTiers, settings] =
    await Promise.all([
      sql`
        select code, name, sort_order as "sortOrder" from calc.markup_groups
        where team_id = ${installer.teamId} order by sort_order, name`,
      sql`
        select id, name, active from calc.suppliers
        where team_id = ${installer.teamId}
        order by sort_order, name`,
      sql`
        select id, parent_id as "parentId", name, product_kind as "productKind",
               markup_group as "markupGroup", quantity_rule as "quantityRule",
               support_eligible as "supportEligible", sort_order as "sortOrder"
        from calc.categories
        where team_id = ${installer.teamId}
        order by sort_order, name`,
      sql`
        select p.id, p.name, p.unit, p.price_ore::int as "priceOre", p.price_updated_at as "priceUpdatedAt",
               p.attachment_url as "attachmentUrl", p.specs, p.category_id as "categoryId", p.active,
               s.id as "supplierId", s.name as "supplierName"
        from calc.products p
        join calc.suppliers s on s.id = p.supplier_id
        where p.team_id = ${installer.teamId}
        order by p.name`,
      sql`
        select markup_group as "markupGroup", percent::float8 as percent
        from calc.installer_markups
        where installer_group_id = ${installer.id}`,
      sql`
        select w.id, w.grp as "group", w.name, w.unit, w.unit_confirmed as "unitConfirmed", w.active,
               w.support_eligible as "supportEligible", r.price_ore::int as "priceOre"
        from calc.work_types w
        left join calc.installer_work_rates r
          on r.work_type_id = w.id and r.installer_group_id = ${installer.id}
        where w.team_id = ${installer.teamId}
        order by w.grp, w.sort_order`,
      sql`
        select rt.id as "roofTypeId", rt.name as "roofTypeName",
               m.product_id as "productId", p.name as "productName", m.price_ore::int as "priceOre"
        from public.roof_types rt
        left join calc.installer_mount_rates m
          on m.roof_type_id = rt.id and m.installer_group_id = ${installer.id}
        left join calc.products p on p.id = m.product_id
        order by rt.name`,
      sql`
        select from_panels as min, to_panels as max, percent::float8 as percent
        from calc.volume_tiers
        where installer_group_id = ${installer.id}
        order by from_panels`,
      sql`
        select from_panels as min, to_panels as max, percent::float8 as percent
        from calc.commission_tiers
        where team_id = ${installer.teamId}
        order by from_panels`,
      loadSettings(installer.teamId),
    ]);

  return {
    installer: { id: installer.id, name: installer.name },
    teamId: installer.teamId,
    canEdit: isAdmin(access, installer.teamId),
    markupGroups,
    suppliers,
    categories,
    products,
    markups: Object.fromEntries(markups.map((m) => [m.markupGroup, m.percent])),
    workTypes,
    mountRates,
    volumeTiers,
    commissionTiers,
    settings,
  };
});
