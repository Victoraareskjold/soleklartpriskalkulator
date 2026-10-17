import "server-only";
import type { CalculationResult } from "@/lib/engine";
import { sql } from "@/lib/server/db";
import type { Settings } from "@/lib/server/settings";
import { planBatteryOffer, type BatteryOfferDraft, type OfferProduct, type OfferWork } from "./battery";

/** Henter katalogdata og regner batteritillegget for et tilbud. */
export async function computeBatteryOffer(
  offer: BatteryOfferDraft | undefined,
  installer: { id: string; teamId: string },
  settings: Settings,
  grid: "230" | "400",
  kwp: number,
  result: CalculationResult,
) {
  const [products, batteryWork, markups] = await Promise.all([
    sql<OfferProduct[]>`
      select p.id, p.name, p.price_ore::int as "priceOre", p.specs, p.attachment_url as "attachmentUrl", p.active,
             c.product_kind as "productKind", s.name as supplier
      from calc.products p
      join calc.categories c on c.id = p.category_id
      join calc.suppliers s on s.id = p.supplier_id
      where p.team_id = ${installer.teamId} and c.product_kind in ('inverter', 'batteri')`,
    sql<OfferWork[]>`
      select w.id, w.name, w.active, r.price_ore::int as "priceOre"
      from calc.work_types w
      left join calc.installer_work_rates r on r.work_type_id = w.id and r.installer_group_id = ${installer.id}
      where w.team_id = ${installer.teamId} and w.grp = 'batteri'
      order by w.sort_order`,
    sql<{ markup_group: string; percent: number }[]>`
      select markup_group, percent::float8 as percent from calc.installer_markups where installer_group_id = ${installer.id}`,
  ]);
  return planBatteryOffer(offer, {
    products,
    batteryWork,
    markups: Object.fromEntries(markups.map((m) => [m.markup_group, m.percent])),
    settings: {
      defaultBatteryClass: settings.defaultBatteryClass,
      hybridDcRatio: settings.hybridDcRatio,
      noPanelCommissionPercent: settings.noPanelCommissionPercent,
    },
    grid,
    kwp,
  }, result);
}
