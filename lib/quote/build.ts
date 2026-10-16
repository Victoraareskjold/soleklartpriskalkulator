import "server-only";
// Bygger motorens input på serveren fra utkastet + databasen.
// Katalogdata (produkttype, kategori, standardpris og påslag) hentes alltid fra databasen.
// Avvik fra katalogen på en linje er en bevisst overstyring og lagres som det.
import type { CalculationInput, LineInput } from "@/lib/engine";
import { sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { loadSettings, type Settings } from "@/lib/server/settings";
import type { Draft, DraftLine } from "./draft";

const kr = (ore: number | null) => (ore == null ? null : String(ore / 100));
const same = (a: string, b: string | null) => b !== null && Number(a.replace(",", ".")) === Number(b);

export interface LineMeta {
  source: "catalog" | "custom";
  sourceId?: string;
  /** Hovedkategori fra katalogen, f.eks. solcellepanel, inverter, feste, batteri, frakt */
  category?: string;
  supplier?: string;
  productName?: string;
  attachmentUrl?: string | null;
  capacityKwh?: number | null;
  workGroup?: string;
  roofTypeName?: string;
  catalogBaseUnit?: string | null;
  catalogMarkupPercent?: string | null;
  overridden: string[];
}

export interface BuiltInput {
  input: CalculationInput;
  /** Satsene som ble brukt, for sporbarhet */
  rules: { commissionTiers: unknown; volumeTiers: unknown; settings: unknown };
  /** Faktisk installert effekt fra panellinjene (paneler × Wp / 1000) */
  kwp: number;
}

export async function buildEngineInput(draft: Draft, installer: { id: string; teamId: string }): Promise<BuiltInput> {
  const ids = (kind: DraftLine["kind"]) => draft.lines.filter((l) => l.kind === kind && l.sourceId).map((l) => l.sourceId!);

  const [products, mounts, works, markups, volumeTiers, commissionTiers, settings] = await Promise.all([
    sql<{ id: string; name: string; price_ore: number; attachment_url: string | null; specs: Record<string, unknown>; product_kind: string; markup_group: string; support_eligible: boolean; category: string; supplier: string }[]>`
      select p.id, p.name, p.price_ore::int as price_ore, p.attachment_url, p.specs,
             c.product_kind, c.markup_group, c.support_eligible, coalesce(parent.name, c.name) as category, s.name as supplier
      from calc.products p
      join calc.categories c on c.id = p.category_id
      left join calc.categories parent on parent.id = c.parent_id
      join calc.suppliers s on s.id = p.supplier_id
      where p.team_id = ${installer.teamId} and p.id = any(${ids("product")}::uuid[])`,
    sql<{ roof_type_id: string; roof_type_name: string; price_ore: number; product_name: string | null; supplier: string | null }[]>`
      select m.roof_type_id, rt.name as roof_type_name, m.price_ore::int as price_ore, p.name as product_name, s.name as supplier
      from calc.installer_mount_rates m
      join public.roof_types rt on rt.id = m.roof_type_id
      left join calc.products p on p.id = m.product_id
      left join calc.suppliers s on s.id = p.supplier_id
      where m.installer_group_id = ${installer.id} and m.roof_type_id = any(${ids("mount")}::uuid[])`,
    sql<{ id: string; name: string; grp: string; price_ore: number | null; support_eligible: boolean }[]>`
      select w.id, w.name, w.grp, r.price_ore::int as price_ore, w.support_eligible
      from calc.work_types w
      left join calc.installer_work_rates r on r.work_type_id = w.id and r.installer_group_id = ${installer.id}
      where w.team_id = ${installer.teamId} and w.id = any(${ids("work")}::uuid[])`,
    sql<{ markup_group: string; percent: number }[]>`
      select markup_group, percent::float8 as percent from calc.installer_markups where installer_group_id = ${installer.id}`,
    sql<{ min: number; max: number | null; percent: number }[]>`
      select from_panels as min, to_panels as max, percent::float8 as percent
      from calc.volume_tiers where installer_group_id = ${installer.id} order by from_panels`,
    sql<{ min: number; max: number | null; percent: number }[]>`
      select from_panels as min, to_panels as max, percent::float8 as percent
      from calc.commission_tiers where team_id = ${installer.teamId} order by from_panels`,
    loadSettings(installer.teamId),
  ]);

  const markup = Object.fromEntries(markups.map((m) => [m.markup_group, String(m.percent)]));
  let kwp = 0;

  const lines: LineInput[] = draft.lines.map((line, index) => {
    const meta: LineMeta = { source: line.sourceId ? "catalog" : "custom", sourceId: line.sourceId, overridden: [] };
    let productKind: string | undefined;
    let catalogSupport = false;
    let catalogBase: string | null = null;
    let catalogMarkup: string | null = null;

    if (line.sourceId && line.kind === "product") {
      const p = products.find((x) => x.id === line.sourceId);
      if (!p) throw new HttpError(400, `Linje ${index + 1}: produktet finnes ikke i katalogen`, "BAD_REQUEST");
      productKind = p.product_kind;
      catalogSupport = p.support_eligible;
      if (p.product_kind === "panel" && typeof p.specs?.wp === "number") {
        kwp += (Number(line.quantity.replace(",", ".")) * p.specs.wp) / 1000;
      }
      catalogBase = kr(p.price_ore);
      catalogMarkup = markup[p.markup_group] ?? null;
      Object.assign(meta, {
        category: p.category,
        supplier: p.supplier,
        productName: p.name,
        attachmentUrl: p.attachment_url,
        capacityKwh: typeof p.specs?.capacityKwh === "number" ? p.specs.capacityKwh : null,
      });
    } else if (line.sourceId && line.kind === "mount") {
      const m = mounts.find((x) => x.roof_type_id === line.sourceId);
      if (!m) throw new HttpError(400, `Linje ${index + 1}: taktypen har ingen monteringspris for installatøren`, "BAD_REQUEST");
      catalogBase = kr(m.price_ore);
      catalogSupport = settings.mountSupportEligible;
      catalogMarkup = markup.montering ?? null;
      Object.assign(meta, { category: "montering", roofTypeName: m.roof_type_name, productName: m.product_name, supplier: m.supplier });
    } else if (line.sourceId && line.kind === "work") {
      const w = works.find((x) => x.id === line.sourceId);
      if (!w) throw new HttpError(400, `Linje ${index + 1}: arbeidstypen finnes ikke`, "BAD_REQUEST");
      catalogBase = kr(w.price_ore);
      catalogSupport = w.support_eligible;
      catalogMarkup = markup.elektro ?? null;
      Object.assign(meta, { category: "elektrisk installasjon", workGroup: w.grp, productName: w.name });
    }

    if (line.sourceId) {
      meta.catalogBaseUnit = catalogBase;
      meta.catalogMarkupPercent = catalogMarkup;
      if (!same(line.baseUnit, catalogBase)) meta.overridden.push("baseUnit");
      if (!same(line.markupPercent, catalogMarkup)) meta.overridden.push("markupPercent");
    }
    if (line.priceMode === "fixed") meta.overridden.push("fixedSale");
    const supportEligible = line.supportEligible ?? (line.sourceId ? catalogSupport : false);
    if (line.sourceId && supportEligible !== catalogSupport) meta.overridden.push("supportEligible");

    return {
      id: line.id,
      name: line.name.trim() || meta.productName || "Uten navn",
      kind: line.kind,
      productKind, // kun fra katalogen – egendefinerte poster teller aldri som paneler
      quantity: line.quantity,
      unit: line.unit,
      baseUnit: line.baseUnit,
      markupPercent: line.markupPercent,
      priceMode: line.priceMode,
      fixedSale: line.priceMode === "fixed" ? line.fixedSale : undefined,
      reductionEligible: line.kind === "mount" && line.reductionEligible,
      supportEligible,
      meta: meta as unknown as Record<string, unknown>,
    };
  });

  const panelCount = lines
    .filter((l) => l.productKind === "panel")
    .reduce((sum, l) => sum + Number(String(l.quantity).replace(",", ".")), 0);

  const support = resolveSupport(draft, settings, kwp);

  const adjustment = (a: Draft["commission"]) => (a.mode === "auto" ? { mode: a.mode } : { mode: a.mode, value: a.value });

  return {
    input: {
      currency: "NOK",
      panelCount,
      lines,
      commission: adjustment(draft.commission),
      commissionTiers: commissionTiers.map((t) => ({ min: t.min, max: t.max, percent: t.percent })),
      noPanelCommissionPercent: settings.noPanelCommissionPercent,
      reduction: adjustment(draft.reduction),
      reductionTiers: volumeTiers.map((t) => ({ min: t.min, max: t.max, percent: t.percent })),
      vatPercent: draft.vatPercent,
      support,
    },
    rules: { commissionTiers, volumeTiers, settings },
    kwp: Number(kwp.toFixed(3)),
  };
}

/**
 * Støtte i kalkylen:
 *  - off: ingen støtte
 *  - manual: eget anslag med valgfri støttegiver (vanlig for næring)
 *  - auto: privatkunde → sentrale støtteregler (Enova). Næring får aldri automatisk støtte.
 */
function resolveSupport(draft: Draft, settings: Settings, kwp: number): CalculationInput["support"] {
  const s = draft.support ?? { mode: "manual" as const, amount: draft.supportAmount ?? "0", provider: "" };
  if (s.mode === "off") return { mode: "none" };
  if (s.mode === "manual") return { mode: "manual", amount: s.amount || "0", provider: s.provider };
  if (draft.customerType === "business" || !settings.supportEnabled) return { mode: "none" };
  return {
    mode: "auto",
    provider: settings.supportName,
    percent: settings.supportPercent,
    perKwp: settings.supportPerKwpOre / 100,
    maxKwp: settings.supportMaxKwp,
    maxAmount: settings.supportMaxOre / 100,
    kwp: Number(kwp.toFixed(3)),
  };
}
