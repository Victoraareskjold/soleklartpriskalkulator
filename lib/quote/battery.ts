// Batteri og hybridinverter som tillegg i tilbudet.
//
// Regnes på serveren etter at grunnkalkylen er regnet, slik at kundeprisene får med:
//   innkjøp → installatørens påslag (solcellemateriell, kan overstyres per tilbud)
//           → Soleklart-sats (samme effektive sats som grunnkalkylen)
// Kunden ser bare ferdige priser (eks. mva.; mva. legges på i tilbudet for privat).
// Den interne oppstillingen (innkjøp, påslag, sats) lagres i den låste versjonen.
//
// Hybrid: kalkulatoren velger først stringinverter til grunnpakken. Hybridalternativet velges
// deretter blant hybridinvertere for samme nett og batteritype, som tåler anleggets PV-effekt,
// helst ikke større enn stringinverteren, rimeligste innkjøp først. Tillegget kunden betaler er
// mellomlegget: hybrid (med påslag) − stringinverter (slik den står i grunnpakken).
import { z } from "zod";
import type { CalculationResult } from "@/lib/engine";

// --- Utkast (hva brukeren har valgt på estimatet) ---

const modelOverride = z.looseObject({
  productId: z.string().min(1),
  enabled: z.boolean().optional(),
  min: z.number().int().min(1).max(200).optional(),
  max: z.number().int().min(1).max(200).optional(),
  /** Innkjøpspris per modul/enhet, overstyrt for dette tilbudet (kr) */
  modulePrice: z.union([z.string(), z.number()]).nullish(),
  bmsProductId: z.string().nullish(),
  /** Innkjøpspris per BMS, overstyrt for dette tilbudet (kr) */
  bmsPrice: z.union([z.string(), z.number()]).nullish(),
  modulesPerBms: z.number().int().min(1).max(100).optional(),
});

export const batteryOfferSchema = z.looseObject({
  /** Vis batteriseksjonen i tilbudet */
  enabled: z.boolean().optional().default(true),
  batteryClass: z.enum(["HV", "LV"]).optional(),
  /** Manuelt valgt hybridinverter. null/mangler = automatisk */
  hybridProductId: z.string().nullish(),
  /** Påslag på batteri og hybrid i prosent. null/mangler = installatørens sats for solcellemateriell */
  markupPercent: z.union([z.string(), z.number()]).nullish(),
  installWorkTypeId: z.string().nullish(),
  /** Installasjon, overstyrt avtalt sats (kr, før elektro-påslag) */
  installPrice: z.union([z.string(), z.number()]).nullish(),
  recommendedModelId: z.string().nullish(),
  recommendedModules: z.number().int().min(1).max(200).nullish(),
  models: z.array(modelOverride).optional(),
});

export type BatteryOfferDraft = z.input<typeof batteryOfferSchema>;

// --- Data fra katalogen ---

export interface OfferProduct {
  id: string;
  name: string;
  priceOre: number;
  specs: Record<string, unknown>;
  attachmentUrl: string | null;
  active: boolean;
  productKind: string;
  supplier: string;
}

export interface OfferWork {
  id: string;
  name: string;
  priceOre: number | null;
  active: boolean;
}

export interface OfferContext {
  products: OfferProduct[];
  batteryWork: OfferWork[];
  markups: Record<string, number>;
  settings: { defaultBatteryClass: "HV" | "LV"; hybridDcRatio: number; noPanelCommissionPercent: number };
  grid: "230" | "400";
  kwp: number;
}

// --- Resultat ---

export interface PriceSteps {
  /** Innkjøp / avtalt sats (øre, eks. mva.) */
  purchaseOre: number;
  /** Etter installatørens påslag (øre) */
  saleOre: number;
  /** Kundepris eks. mva., inkl. Soleklart (øre) */
  customerOre: number;
}

export interface BatteryOfferResult {
  enabled: boolean;
  batteryClass: "HV" | "LV";
  /** Installatørens påslag brukt på batteri og hybrid (%) */
  materialMarkupPercent: number;
  materialMarkupOverridden: boolean;
  elektroMarkupPercent: number;
  /** Effektiv Soleklart-sats fra grunnkalkylen (kommisjon / sum før Soleklart) */
  commissionRate: number;
  stringInverter: { productId: string | null; name: string; acKw: number | null; saleUnitOre: number; datasheetUrl: string | null } | null;
  hybridIncluded: boolean;
  hybrid: (PriceSteps & { productId: string; name: string; acKw: number | null; batteryClass: string | null; datasheetUrl: string | null; auto: boolean }) | null;
  /** Mellomlegg for å bytte til hybrid */
  upgrade: { saleOre: number; customerOre: number };
  hybridCandidates: { productId: string; name: string; acKw: number | null; supplier: string; purchaseOre: number; fits: boolean }[];
  install: (PriceSteps & { workTypeId: string | null; name: string }) | null;
  models: {
    productId: string;
    name: string;
    enabled: boolean;
    structure: "modular" | "unit";
    moduleKwh: number;
    batteryClass: string | null;
    min: number;
    max: number;
    modulesPerBms: number;
    module: PriceSteps;
    modulePriceOverridden: boolean;
    bms: (PriceSteps & { productId: string | null; name: string; overridden: boolean }) | null;
    datasheetUrl: string | null;
  }[];
  recommended: { model: string; modules: number } | null;
  warnings: string[];
  /** Det kundesiden leser (price_data.batterySection). Kroner eks. mva., inkl. Soleklart. */
  section: Record<string, unknown> | null;
}

const BMS_PATTERN = /\b(bms|base|kontrollenhet|styringsenhet|control\s*unit|hvc|high\s*voltage\s*control|power\s*module|effektmodul)\b/i;
export const isBms = (p: OfferProduct) => p.specs?.bms === true || (p.specs?.bms !== false && BMS_PATTERN.test(p.name));
const brandOf = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const num = (v: unknown) => (typeof v === "number" ? v : v == null || v === "" ? NaN : Number(String(v).replace(",", ".")));
const kr = (ore: number) => Math.round(ore / 100);

export function planBatteryOffer(draft: BatteryOfferDraft | undefined, ctx: OfferContext, result: CalculationResult): BatteryOfferResult {
  const offer = batteryOfferSchema.parse(draft ?? {});
  const warnings: string[] = [];
  const batteryClass = offer.batteryClass ?? ctx.settings.defaultBatteryClass;

  const overrideMarkup = num(offer.markupPercent);
  const materialMarkup = Number.isFinite(overrideMarkup) && overrideMarkup >= 0 ? overrideMarkup : (ctx.markups.solcellemateriell ?? 0);
  const elektroMarkup = ctx.markups.elektro ?? 0;
  const rate =
    result.totals.subtotal > 0 ? result.commission.amount / result.totals.subtotal : ctx.settings.noPanelCommissionPercent / 100;

  const withMarkup = (ore: number, pct: number) => Math.round(ore * (1 + pct / 100));
  const customer = (saleOre: number) => Math.round(saleOre * (1 + rate));
  const steps = (purchaseOre: number, pct: number): PriceSteps => {
    const saleOre = withMarkup(purchaseOre, pct);
    return { purchaseOre, saleOre, customerOre: customer(saleOre) };
  };

  // Stringinverteren i grunnpakken
  const inverterLine = result.lines.find((l) => l.productKind === "inverter");
  const lineSourceId = (inverterLine?.meta as { sourceId?: string } | undefined)?.sourceId ?? null;
  const baseInverter = ctx.products.find((p) => p.id === lineSourceId) ?? null;
  const stringInverter = inverterLine
    ? {
        productId: baseInverter?.id ?? null,
        name: baseInverter?.name ?? inverterLine.name,
        acKw: num(baseInverter?.specs.acKw) || null,
        saleUnitOre: Math.round(inverterLine.sale / (Number(inverterLine.quantity) || 1)),
        datasheetUrl: baseInverter?.attachmentUrl ?? null,
      }
    : null;
  const hybridIncluded = baseInverter?.specs.hybrid === true;

  // Hybridalternativ
  const kwp = ctx.kwp;
  const pvOk = (p: OfferProduct) => {
    const maxPv = num(p.specs.maxPvKwp);
    if (Number.isFinite(maxPv)) return maxPv >= kwp;
    return (num(p.specs.acKw) || 0) * ctx.settings.hybridDcRatio >= kwp;
  };
  const hybridFits = (p: OfferProduct) =>
    p.specs.hybrid === true &&
    (p.specs.grid === ctx.grid || p.specs.grid === "begge") &&
    (!p.specs.batteryClass || p.specs.batteryClass === batteryClass) &&
    num(p.specs.acKw) > 0 &&
    pvOk(p);
  const hybrids = ctx.products.filter((p) => p.active && p.productKind === "inverter" && p.specs.hybrid === true);
  const hybridCandidates = hybrids
    .map((p) => ({ productId: p.id, name: p.name, acKw: num(p.specs.acKw) || null, supplier: p.supplier, purchaseOre: p.priceOre, fits: hybridFits(p) }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || a.purchaseOre - b.purchaseOre || (a.acKw ?? 0) - (b.acKw ?? 0));

  let hybridProduct: OfferProduct | null = null;
  let hybridAuto = true;
  if (hybridIncluded && baseInverter) {
    hybridProduct = baseInverter;
  } else if (offer.hybridProductId) {
    hybridProduct = ctx.products.find((p) => p.id === offer.hybridProductId) ?? null;
    hybridAuto = false;
    if (!hybridProduct) warnings.push("Valgt hybridinverter finnes ikke lenger i katalogen. Velger automatisk.");
    else if (!hybridFits(hybridProduct)) warnings.push(`${hybridProduct.name} passer ikke ${ctx.grid} V / ${batteryClass} / ${kwp.toLocaleString("nb-NO")} kWp.`);
  }
  if (!hybridProduct) {
    hybridAuto = true;
    const fitting = hybrids.filter(hybridFits).sort((a, b) => a.priceOre - b.priceOre || (num(a.specs.acKw) || 0) - (num(b.specs.acKw) || 0));
    const stringAc = stringInverter?.acKw ?? Infinity;
    // Helst ikke større enn stringinverteren (lavere AC er greit når PV-siden tåler anlegget)
    hybridProduct = fitting.find((p) => num(p.specs.acKw) <= stringAc) ?? fitting[0] ?? null;
    if (!hybridProduct && kwp > 0) {
      warnings.push(`Fant ingen hybridinverter for ${ctx.grid} V og ${batteryClass}-batteri som tåler ${kwp.toLocaleString("nb-NO")} kWp. Velg manuelt eller legg inn produktdata.`);
    }
  }

  const hybridSteps = hybridProduct ? steps(hybridProduct.priceOre, materialMarkup) : null;
  const upgradeSale = hybridIncluded || !hybridSteps ? 0 : Math.max(0, hybridSteps.saleOre - (stringInverter?.saleUnitOre ?? 0));
  if (!hybridIncluded && hybridSteps && stringInverter && hybridSteps.saleOre < stringInverter.saleUnitOre) {
    warnings.push("Hybridinverteren er rimeligere enn stringinverteren. Mellomlegget settes til 0 kr.");
  }

  // Installasjon av batteri
  const installWork =
    ctx.batteryWork.find((w) => w.id === offer.installWorkTypeId) ??
    ctx.batteryWork.find((w) => w.active && w.priceOre != null && /uten backup/i.test(w.name)) ??
    ctx.batteryWork.find((w) => w.active && w.priceOre != null) ??
    null;
  const installOverride = num(offer.installPrice);
  const installPurchase = Number.isFinite(installOverride) ? Math.round(installOverride * 100) : installWork?.priceOre ?? null;
  const install =
    installPurchase != null ? { workTypeId: installWork?.id ?? null, name: installWork?.name ?? "Installasjon av batteri", ...steps(installPurchase, elektroMarkup) } : null;
  if (!install) warnings.push("Ingen avtalt pris for batteriinstallasjon hos installatøren.");

  // Batterimodeller
  const batteries = ctx.products.filter((p) => p.productKind === "batteri" && p.active);
  const bmsList = batteries.filter(isBms);
  const overrides = new Map((offer.models ?? []).map((m) => [m.productId, m]));
  const models = batteries
    .filter((p) => !isBms(p))
    .map((p) => {
      const o = overrides.get(p.id);
      const specs = p.specs ?? {};
      const bmsId = o?.bmsProductId !== undefined ? o.bmsProductId : (specs.bmsProductId as string | undefined);
      const bmsProduct =
        (bmsId ? ctx.products.find((b) => b.id === bmsId) : undefined) ??
        (bmsId === null ? undefined : bmsList.find((b) => brandOf(b.name) === brandOf(p.name)));
      const bmsOverride = num(o?.bmsPrice);
      const hasBms = Boolean(bmsProduct) || Number.isFinite(bmsOverride);
      const structure: "modular" | "unit" = hasBms ? "modular" : "unit";
      const perBms = o?.modulesPerBms ?? (Number(specs.modulesPerBase) || (structure === "modular" ? 8 : 1));
      const min = o?.min ?? (Number(specs.minModules) || (structure === "modular" ? 2 : 1));
      const max = Math.max(min, o?.max ?? (Number(specs.maxModules) || (structure === "modular" ? perBms * 3 : 4)));
      const moduleOverride = num(o?.modulePrice);
      const modulePurchase = Number.isFinite(moduleOverride) ? Math.round(moduleOverride * 100) : p.priceOre;
      const bmsPurchase = Number.isFinite(bmsOverride) ? Math.round(bmsOverride * 100) : bmsProduct?.priceOre ?? null;
      const cls = (specs.batteryClass as string | undefined) ?? null;
      const moduleKwh = num(specs.capacityKwh) || 0;
      if (!moduleKwh) warnings.push(`${p.name} mangler kapasitet (kWh) i produktdata.`);
      return {
        productId: p.id,
        name: p.name,
        // Standard: modeller med valgt batteritype er med
        enabled: o?.enabled ?? (!cls || cls === batteryClass),
        structure,
        moduleKwh,
        batteryClass: cls,
        min,
        max,
        modulesPerBms: perBms,
        module: steps(modulePurchase, materialMarkup),
        modulePriceOverridden: Number.isFinite(moduleOverride),
        bms:
          structure === "modular" && bmsPurchase != null
            ? { productId: bmsProduct?.id ?? null, name: bmsProduct?.name ?? "BMS", overridden: Number.isFinite(bmsOverride), ...steps(bmsPurchase, materialMarkup) }
            : null,
        datasheetUrl: p.attachmentUrl,
      };
    });

  const enabledModels = models.filter((m) => m.enabled && m.moduleKwh > 0);
  const recModel = enabledModels.find((m) => m.productId === offer.recommendedModelId) ?? enabledModels[0];
  const recommended = recModel
    ? {
        model: recModel.productId,
        modules: Math.max(recModel.min, Math.min(recModel.max, offer.recommendedModules ?? (Math.round(10 / recModel.moduleKwh) || recModel.min))),
      }
    : null;
  if (offer.enabled && !enabledModels.length) warnings.push("Ingen batterimodeller er valgt for tilbudet.");

  const section = offer.enabled
    ? {
        pricesIncludeCommission: true,
        hybridQty: 1,
        hybridUnitEx: kr(customer(upgradeSale)),
        hybridIncluded,
        hybrid: hybridProduct
          ? { name: hybridProduct.name, acKw: num(hybridProduct.specs.acKw) || null, datasheetUrl: hybridProduct.attachmentUrl }
          : null,
        stringInverter: stringInverter ? { name: stringInverter.name, datasheetUrl: stringInverter.datasheetUrl } : null,
        batteryInstallEx: install ? kr(install.customerOre) : 0,
        recommended,
        catalogue: Object.fromEntries(
          enabledModels.map((m) => [
            m.productId,
            {
              id: m.productId,
              brand: m.name,
              structure: m.structure,
              moduleKwh: m.moduleKwh,
              min: m.min,
              max: m.max,
              modulesPerBase: m.structure === "modular" ? m.modulesPerBms : null,
              baseEx: m.bms ? kr(m.bms.customerOre) : 0,
              bmsName: m.bms ? m.bms.name : null,
              moduleEx: kr(m.module.customerOre),
              discountEnabled: false,
              tiers: [],
              supplierFromKwh: 50,
              datasheetUrl: m.datasheetUrl,
            },
          ]),
        ),
      }
    : null;

  return {
    enabled: offer.enabled,
    batteryClass,
    materialMarkupPercent: materialMarkup,
    materialMarkupOverridden: Number.isFinite(overrideMarkup) && overrideMarkup >= 0,
    elektroMarkupPercent: elektroMarkup,
    commissionRate: rate,
    stringInverter,
    hybridIncluded,
    hybrid: hybridProduct && hybridSteps
      ? {
          productId: hybridProduct.id,
          name: hybridProduct.name,
          acKw: num(hybridProduct.specs.acKw) || null,
          batteryClass: (hybridProduct.specs.batteryClass as string | undefined) ?? null,
          datasheetUrl: hybridProduct.attachmentUrl,
          auto: hybridAuto,
          ...hybridSteps,
        }
      : null,
    upgrade: { saleOre: upgradeSale, customerOre: customer(upgradeSale) },
    hybridCandidates,
    install,
    models,
    recommended,
    warnings,
    section,
  };
}
