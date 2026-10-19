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

const hybridCustomSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Innkjøpspris per stk (kr) */
  price: z.union([z.string(), z.number()]),
  quantity: z.number().int().min(1).max(50).optional(),
});

/** Soleklart-kommisjon på hybridoppgraderingen: auto = samme sats som grunnkalkylen */
export const hybridCommissionSchema = z.object({
  mode: z.enum(["auto", "percent", "amount"]),
  /** Prosent av grunnlaget (prisforskjell etter rabatt), eller fast beløp i kr eks. mva. */
  value: z.union([z.string(), z.number()]).nullish(),
});
export type HybridCommission = z.infer<typeof hybridCommissionSchema>;

export const batteryOfferSchema = z.looseObject({
  /** Vis batteriseksjonen i tilbudet */
  enabled: z.boolean().optional().default(true),
  batteryClass: z.enum(["HV", "LV"]).optional(),
  /** Manuelt valgt hybridinverter. null/mangler = automatisk */
  hybridProductId: z.string().nullish(),
  /** Egen hybridinverter som ikke ligger i katalogen (navn, innkjøp per stk, antall) */
  hybridCustom: hybridCustomSchema.nullish(),
  /** Soleklart-kommisjon på hybridoppgraderingen. Mangler = standarden (Beregningsregler) eller grunnkalkylens sats */
  hybridCommission: hybridCommissionSchema.nullish(),
  /** Manuell pris kunden betaler for oppgraderingen, kr eks. mva. Differansen blir rabatt (eller tillegg). */
  hybridPrice: z.union([z.string(), z.number()]).nullish(),
  /** Antall hybridinvertere. Mangler = like mange som stringinvertere i grunnpakken */
  hybridQuantity: z.number().int().min(1).max(50).nullish(),
  /** Rekkefølgen batterimodellene vises i for kunden (produkt-ID-er). Mangler = standardoppsettet */
  modelOrder: z.array(z.string()).max(100).nullish(),
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
  supplierId?: string;
}

/** Foretrukne leverandører og merker. Tomme lister = ingen preferanse. */
export interface Preference {
  supplierIds?: string[];
  brands?: string[];
}

export function isPreferred(p: { name: string; supplierId?: string }, pref?: Preference | null) {
  const suppliers = pref?.supplierIds ?? [];
  const brands = (pref?.brands ?? []).map((b) => b.trim().toLowerCase()).filter(Boolean);
  if (!suppliers.length && !brands.length) return false;
  const supplierOk = !suppliers.length || (!!p.supplierId && suppliers.includes(p.supplierId));
  const brandOk = !brands.length || brands.some((b) => p.name.toLowerCase().includes(b));
  return supplierOk && brandOk;
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
  settings: {
    defaultBatteryClass: "HV" | "LV";
    hybridDcRatio: number;
    noPanelCommissionPercent: number;
    /** Foretrukne hybridinvertere og batterier */
    preferences?: { hybrid?: Preference; battery?: Preference };
    /** Standard batteriutvalg og rekkefølge for nye tilbud */
    batteryModels?: string[];
    /** Standard kommisjon på hybridoppgraderinger */
    hybridCommission?: HybridCommission | null;
  };
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
  stringInverter: { productId: string | null; name: string; acKw: number | null; saleUnitOre: number; quantity: number; datasheetUrl: string | null } | null;
  hybridIncluded: boolean;
  hybrid:
    | (PriceSteps & {
        productId: string | null;
        name: string;
        acKw: number | null;
        batteryClass: string | null;
        datasheetUrl: string | null;
        auto: boolean;
        custom: boolean;
        quantity: number;
        preferred: boolean;
      })
    | null;
  /** Mellomlegg for å bytte til hybrid */
  /**
   * Mellomlegget for å bytte til hybrid, øre eks. mva.:
   *   prisforskjell (hybrid salg − stringinverter salg) − rabatt = grunnlag
   *   grunnlag + Soleklart-kommisjon = kundepris
   * saleOre = grunnlaget (installatørens del etter rabatt). Alltid: customerOre = saleOre + commissionOre.
   */
  upgrade: {
    differenceOre: number;
    discountOre: number;
    saleOre: number;
    commissionOre: number;
    customerOre: number;
    commission: { mode: "auto" | "percent" | "amount"; percent: number | null; amountOre: number | null; fromDefault: boolean };
    manualPrice: boolean;
  };
  hybridCandidates: { productId: string; name: string; acKw: number | null; supplier: string; purchaseOre: number; fits: boolean; preferred: boolean }[];
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
    preferred: boolean;
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

  // Stringinverteren(e) i grunnpakken (katalog eller egendefinert linje)
  const inverterLines = result.lines.filter((l) => l.productKind === "inverter");
  const inverterLine = inverterLines[0];
  const lineSourceId = (inverterLine?.meta as { sourceId?: string } | undefined)?.sourceId ?? null;
  const baseInverter = ctx.products.find((p) => p.id === lineSourceId) ?? null;
  const stringQty = Math.max(1, inverterLines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0));
  const stringInverter = inverterLine
    ? {
        productId: baseInverter?.id ?? null,
        name: inverterLines.length > 1 ? inverterLines.map((l) => l.name).join(" + ") : baseInverter?.name ?? inverterLine.name,
        acKw: num(baseInverter?.specs.acKw) || null,
        saleUnitOre: Math.round(inverterLines.reduce((sum, l) => sum + l.sale, 0) / stringQty),
        quantity: stringQty,
        datasheetUrl: baseInverter?.attachmentUrl ?? null,
      }
    : null;
  const hybridIncluded = baseInverter?.specs.hybrid === true;

  // Hybridalternativ. Standard: like mange hybrider som stringinvertere, hver dimensjonert for sin andel av anlegget.
  const hybridQty = hybridIncluded ? stringQty : (offer.hybridCustom?.quantity ?? offer.hybridQuantity ?? stringQty);
  const kwp = ctx.kwp;
  const kwpPerHybrid = kwp / Math.max(1, hybridQty);
  const pvOk = (p: OfferProduct) => {
    const maxPv = num(p.specs.maxPvKwp);
    if (Number.isFinite(maxPv)) return maxPv >= kwpPerHybrid;
    return (num(p.specs.acKw) || 0) * ctx.settings.hybridDcRatio >= kwpPerHybrid;
  };
  const hybridFits = (p: OfferProduct) =>
    p.specs.hybrid === true &&
    (p.specs.grid === ctx.grid || p.specs.grid === "begge") &&
    (!p.specs.batteryClass || p.specs.batteryClass === batteryClass) &&
    num(p.specs.acKw) > 0 &&
    pvOk(p);
  const hybridPref = ctx.settings.preferences?.hybrid;
  const preferred = (p: OfferProduct) => isPreferred(p, hybridPref);
  const hybrids = ctx.products.filter((p) => p.active && p.productKind === "inverter" && p.specs.hybrid === true);
  const hybridCandidates = hybrids
    .map((p) => ({
      productId: p.id,
      name: p.name,
      acKw: num(p.specs.acKw) || null,
      supplier: p.supplier,
      purchaseOre: p.priceOre,
      fits: hybridFits(p),
      preferred: preferred(p),
    }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || Number(b.preferred) - Number(a.preferred) || a.purchaseOre - b.purchaseOre || (a.acKw ?? 0) - (b.acKw ?? 0));

  let hybridProduct: OfferProduct | null = null;
  let hybridAuto = true;
  const custom = offer.hybridCustom && !hybridIncluded ? offer.hybridCustom : null;
  const customPrice = custom ? num(custom.price) : NaN;
  if (custom && !(customPrice >= 0)) warnings.push("Egen hybridinverter mangler gyldig pris.");
  if (hybridIncluded && baseInverter) {
    hybridProduct = baseInverter;
  } else if (custom && customPrice >= 0) {
    hybridProduct = {
      id: "",
      name: custom.name,
      priceOre: Math.round(customPrice * 100),
      specs: {},
      attachmentUrl: null,
      active: true,
      productKind: "inverter",
      supplier: "Egendefinert",
    };
    hybridAuto = false;
  } else if (offer.hybridProductId) {
    hybridProduct = ctx.products.find((p) => p.id === offer.hybridProductId) ?? null;
    hybridAuto = false;
    if (!hybridProduct) warnings.push("Valgt hybridinverter finnes ikke lenger i katalogen. Velger automatisk.");
    else if (!hybridFits(hybridProduct)) warnings.push(`${hybridProduct.name} passer ikke ${ctx.grid} V / ${batteryClass} / ${kwpPerHybrid.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} kWp per inverter.`);
  }
  if (!hybridProduct) {
    hybridAuto = true;
    const stringAc = stringInverter?.acKw ?? Infinity;
    // Foretrukne merker/leverandører først, så helst ikke større enn stringinverteren, så rimeligst
    const fitting = hybrids
      .filter(hybridFits)
      .sort(
        (a, b) =>
          Number(preferred(b)) - Number(preferred(a)) ||
          Number(num(b.specs.acKw) <= stringAc) - Number(num(a.specs.acKw) <= stringAc) ||
          a.priceOre - b.priceOre ||
          (num(a.specs.acKw) || 0) - (num(b.specs.acKw) || 0),
      );
    hybridProduct = fitting[0] ?? null;
    if (!hybridProduct && kwp > 0) {
      warnings.push(
        `Fant ingen hybridinverter for ${ctx.grid} V og ${batteryClass}-batteri som tåler ${kwpPerHybrid.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} kWp${hybridQty > 1 ? ` per inverter (${hybridQty} stk.)` : ""}. Velg fra katalogen, legg inn en egen hybridinverter, eller endre antall.`,
      );
    }
  }

  const hybridSteps = hybridProduct ? steps(hybridProduct.priceOre, materialMarkup) : null;
  // Mellomlegg: hybridene (med påslag) − stringinverterne de erstatter, slik de står i grunnpakken
  const replaced = Math.min(hybridQty, stringQty) * (stringInverter?.saleUnitOre ?? 0);
  const difference = hybridIncluded || !hybridSteps ? 0 : Math.max(0, hybridQty * hybridSteps.saleOre - replaced);

  // Kommisjon på oppgraderingen: tilbudets valg → standard fra Beregningsregler → grunnkalkylens sats
  const commissionChoice = offer.hybridCommission ?? ctx.settings.hybridCommission ?? { mode: "auto" as const, value: null };
  const commissionValue = num(commissionChoice.value);
  const commissionMode: "auto" | "percent" | "amount" =
    commissionChoice.mode !== "auto" && Number.isFinite(commissionValue) && commissionValue >= 0 ? commissionChoice.mode : "auto";
  const pct = commissionMode === "percent" ? commissionValue / 100 : commissionMode === "auto" ? rate : null;
  const fixedOre = commissionMode === "amount" ? Math.round(commissionValue * 100) : null;

  // Manuell kundepris (eks. mva.): grunnlaget regnes tilbake, så kundepris = grunnlag + kommisjon alltid stemmer
  const manual = num(offer.hybridPrice);
  const manualPrice = !hybridIncluded && !!hybridSteps && Number.isFinite(manual) && manual >= 0;
  let upgradeSale: number;
  let commissionOre: number;
  if (manualPrice) {
    const priceOre = Math.round(manual * 100);
    if (fixedOre != null) {
      commissionOre = Math.min(fixedOre, priceOre);
      upgradeSale = priceOre - commissionOre;
    } else {
      upgradeSale = Math.round(priceOre / (1 + (pct ?? 0)));
      commissionOre = priceOre - upgradeSale;
    }
    if (fixedOre != null && fixedOre > priceOre) warnings.push("Den faste kommisjonen er høyere enn prisen for oppgraderingen. Kommisjonen er satt lik prisen.");
  } else {
    upgradeSale = difference;
    commissionOre = fixedOre != null ? (difference > 0 ? fixedOre : 0) : Math.round(difference * (pct ?? 0));
  }
  const discountOre = difference - upgradeSale;
  const upgradeCustomer = upgradeSale + commissionOre;
  if (!hybridIncluded && hybridSteps && stringInverter && hybridQty * hybridSteps.saleOre < replaced) {
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
  const defaultModels = ctx.settings.batteryModels ?? [];
  const order = offer.modelOrder?.length ? offer.modelOrder : defaultModels;
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? 10_000 : i;
  };
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
        // Standard: lagret standardutvalg, ellers modeller med valgt batteritype
        enabled: o?.enabled ?? (defaultModels.length ? defaultModels.includes(p.id) : !cls || cls === batteryClass),
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
        preferred: isPreferred(p, ctx.settings.preferences?.battery),
      };
    })
    .sort((a, b) => rank(a.productId) - rank(b.productId) || Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name, "nb"));

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
        enabled: true,
        pricesIncludeCommission: true,
        hybridQty,
        hybridUnitEx: kr(upgradeCustomer / Math.max(1, hybridQty)),
        hybridIncluded,
        hybrid: hybridProduct
          ? { name: hybridProduct.name, acKw: num(hybridProduct.specs.acKw) || null, datasheetUrl: hybridProduct.attachmentUrl }
          : null,
        order: enabledModels.map((m) => m.productId),
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
    : // Slått av: kunden ser verken hybridoppgradering eller batteri
      { enabled: false };

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
          productId: hybridProduct.id || null,
          name: hybridProduct.name,
          custom: Boolean(custom) && !hybridIncluded && hybridProduct.id === "",
          quantity: hybridQty,
          preferred: hybridProduct.id ? preferred(hybridProduct) : false,
          acKw: num(hybridProduct.specs.acKw) || null,
          batteryClass: (hybridProduct.specs.batteryClass as string | undefined) ?? null,
          datasheetUrl: hybridProduct.attachmentUrl,
          auto: hybridAuto,
          ...hybridSteps,
        }
      : null,
    upgrade: {
      differenceOre: difference,
      discountOre,
      saleOre: upgradeSale,
      commissionOre,
      customerOre: upgradeCustomer,
      commission: {
        mode: commissionMode,
        percent: pct == null ? null : Math.round(pct * 1_000_000) / 10_000,
        amountOre: fixedOre,
        fromDefault: !offer.hybridCommission && !!ctx.settings.hybridCommission,
      },
      manualPrice,
    },
    hybridCandidates,
    install,
    models,
    recommended,
    warnings,
    section,
  };
}
