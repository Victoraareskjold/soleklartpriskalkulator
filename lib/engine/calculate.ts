// Ren beregningsmotor. Ingen database, ingen UI. Alle beløp ut er i øre.
//
// Rekkefølge:
//   1. Mengde × enhetsgrunnlag, avrundet per linje
//   2. Volumrabatt på monteringslinjer (reductionEligible)
//   3. Påslag på redusert grunnlag (fast salgsbeløp overstyrer kun salget)
//   4. Sum før Soleklart
//   5. Soleklart-kommisjon (trinn, prosent eller fast beløp)
//   6. Mva. på alt inkl. kommisjon
//   7. Støtte vises separat og endrer ikke faktura eller kommisjon
import { CalculationError } from "./errors";
import { allocate, multiply, nonNegative, percentOf, scale, sum, toOre } from "./money";
import {
  DEFAULT_COMMISSION_TIERS,
  DEFAULT_NO_PANEL_COMMISSION_PERCENT,
  findTier,
} from "./tiers";
import type {
  AdjustmentMode,
  CalculatedLine,
  CalculationInput,
  CalculationResult,
  LineInput,
  Ore,
  SupportResult,
  Warning,
} from "./types";

export const ENGINE_VERSION = "0.2.0";

const LINE_KINDS = ["product", "mount", "work"];
const PRICE_MODES = ["auto", "fixed"];
const ADJUSTMENT_MODES = ["auto", "percent", "amount"];

type NormalizedLine = Omit<CalculatedLine, "reduction" | "reducedBase" | "automaticSale" | "sale" | "markupAmount">;

function normalizeLines(lines: LineInput[]): NormalizedLine[] {
  const ids = new Set<string>();

  return lines.map((line, index) => {
    const field = `lines.${index}`;

    if (!line.id || ids.has(line.id)) throw new CalculationError("Prislinjene må ha unike ID-er", field);
    ids.add(line.id);
    if (!line.name?.trim()) throw new CalculationError("Prislinjen mangler navn", field);
    if (!LINE_KINDS.includes(line.kind)) throw new CalculationError("Ukjent linjetype", field);
    if (!PRICE_MODES.includes(line.priceMode ?? "auto")) throw new CalculationError("Ukjent prismodus", field);

    const quantity = nonNegative(line.quantity, `${field}.quantity`);
    nonNegative(line.baseUnit, `${field}.baseUnit`);
    const baseUnit = toOre(line.baseUnit, `${field}.baseUnit`);
    const base = multiply(baseUnit, line.quantity, `${field}.quantity`);

    const markupPercent = nonNegative(line.markupPercent, `${field}.markupPercent`);
    if (markupPercent > 1000) throw new CalculationError("Påslag over 1 000 % må avklares", field);

    if (line.reductionEligible && line.kind !== "mount") {
      throw new CalculationError("Volumreduksjon gjelder bare monteringslinjer", field);
    }
    if ((line.priceMode ?? "auto") === "fixed") nonNegative(line.fixedSale, `${field}.fixedSale`);

    return { ...line, quantity, baseUnit, base, markupPercent };
  });
}

function assertPanelCount(lines: NormalizedLine[], panelCount: number) {
  const counted = sum(
    lines
      .filter((line) => line.productKind === "panel")
      .map((line) => {
        if (!Number.isInteger(line.quantity)) {
          throw new CalculationError("Paneler må ha helt antall", "panelCount");
        }
        return line.quantity;
      }),
  );
  if (counted !== panelCount) {
    throw new CalculationError("Panelantall stemmer ikke med prislinjene", "panelCount");
  }
}

function resolveReduction(input: CalculationInput, eligibleBase: Ore, warnings: Warning[]) {
  const reduction = input.reduction ?? { mode: "auto" as const };
  if (!ADJUSTMENT_MODES.includes(reduction.mode)) {
    throw new CalculationError("Ukjent rabattmodus", "reduction.mode");
  }

  let percent: number | null = null;
  let amount: Ore = 0;

  if (reduction.mode === "auto") {
    const tiers = input.reductionTiers ?? [];
    const tier = findTier(input.panelCount, tiers, "reductionTiers");
    percent = tier ? nonNegative(tier.percent, "reductionTiers") : 0;

    // Under laveste trinn = 0 % rabatt. Over/mellom trinn uten regel = blokkerende avvik.
    const lowestMin = Math.min(...tiers.map((t) => t.min));
    if (eligibleBase > 0 && (!tiers.length || (!tier && input.panelCount >= lowestMin))) {
      warnings.push({
        code: "REDUCTION_GAP",
        message: "Ingen volumregel dekker panelantallet. Velg manuell rabatt før tilbudet lagres.",
        blocking: true,
      });
    }
  } else if (reduction.mode === "percent") {
    percent = nonNegative(reduction.value, "reduction.value");
  } else {
    nonNegative(reduction.value, "reduction.value");
    amount = toOre(reduction.value!, "reduction.value");
  }

  if (percent !== null) {
    if (percent > 100) throw new CalculationError("Rabatt kan ikke overstige 100 %", "reduction");
    amount = percentOf(eligibleBase, percent, "reduction");
  }
  if (amount > eligibleBase) {
    throw new CalculationError("Rabatten overstiger monteringsgrunnlaget", "reduction");
  }

  return { mode: reduction.mode as AdjustmentMode, percent, amount, base: eligibleBase };
}

function resolveCommission(input: CalculationInput, subtotal: Ore) {
  const commission = input.commission ?? { mode: "auto" as const };
  let percent: number | null = null;
  let amount: Ore = 0;

  if (commission.mode === "auto") {
    if (input.panelCount === 0) {
      percent = nonNegative(
        input.noPanelCommissionPercent ?? DEFAULT_NO_PANEL_COMMISSION_PERCENT,
        "noPanelCommissionPercent",
      );
    } else {
      const tier = findTier(
        input.panelCount,
        input.commissionTiers ?? DEFAULT_COMMISSION_TIERS,
        "commissionTiers",
      );
      if (!tier) throw new CalculationError("Kommisjonstrinn mangler for panelantallet", "commissionTiers");
      percent = nonNegative(tier.percent, "commissionTiers");
    }
  } else if (commission.mode === "percent") {
    percent = nonNegative(commission.value, "commission.value");
  } else if (commission.mode === "total") {
    // Avtalt sluttsum eks. mva.: Soleklart-kommisjonen tar differansen
    nonNegative(commission.value, "commission.value");
    amount = toOre(commission.value!, "commission.value") - subtotal;
    if (amount < 0) {
      throw new CalculationError(
        "Avtalt pris er lavere enn summen før Soleklart. Reduser linjene eller velg en høyere pris.",
        "commission.value",
      );
    }
  } else if (commission.mode === "amount") {
    nonNegative(commission.value, "commission.value");
    amount = toOre(commission.value!, "commission.value");
  } else {
    throw new CalculationError("Ukjent kommisjonsmodus", "commission.mode");
  }

  if (percent !== null) {
    if (percent > 100) throw new CalculationError("Kommisjon kan ikke overstige 100 %", "commission");
    amount = percentOf(subtotal, percent, "commission");
  }

  return { mode: commission.mode as AdjustmentMode, percent, amount, base: subtotal };
}

function resolveSupport(
  input: CalculationInput,
  lines: CalculatedLine[],
  subtotal: Ore,
  totalExVat: Ore,
  vatPercent: number,
): SupportResult {
  const support = input.support ?? { mode: "manual" as const, amount: input.supportAmount ?? 0 };
  const empty = { eligibleBaseIncVat: null, byPercent: null, byKwp: null, cap: null, kwp: null };

  if (support.mode === "none") return { mode: "none", provider: null, amount: 0, ...empty };

  if (support.mode === "manual") {
    nonNegative(support.amount, "support.amount");
    return { mode: "manual", provider: support.provider?.trim() || null, amount: toOre(support.amount, "support.amount"), ...empty };
  }

  if (support.mode !== "auto") throw new CalculationError("Ukjent støttemodus", "support.mode");

  // Støtteberettigede linjer får sin forholdsmessige andel av kommisjonen, og mva. legges på.
  const eligibleSale = sum(lines.filter((l) => l.supportEligible).map((l) => l.sale));
  const eligibleExVat = scale(eligibleSale, totalExVat, subtotal, "support");
  const eligibleBaseIncVat = sum([eligibleExVat, percentOf(eligibleExVat, vatPercent, "support")]);

  // kWp regnes ofte ut som flyttall (36 × 0,46); avrund til 6 desimaler før kontroll.
  const kwp = nonNegative(typeof support.kwp === "number" ? Number(support.kwp.toFixed(6)) : support.kwp, "support.kwp");
  const maxKwp = nonNegative(support.maxKwp, "support.maxKwp");
  const cappedKwp = Math.min(kwp, maxKwp).toFixed(6);

  nonNegative(support.perKwp, "support.perKwp");
  nonNegative(support.maxAmount, "support.maxAmount");
  if (nonNegative(support.percent, "support.percent") > 100) throw new CalculationError("Støtteprosent over 100", "support.percent");

  const byPercent = percentOf(eligibleBaseIncVat, support.percent, "support.percent");
  const byKwp = multiply(toOre(support.perKwp, "support.perKwp"), cappedKwp, "support.kwp");
  const cap = toOre(support.maxAmount, "support.maxAmount");

  return {
    mode: "auto",
    provider: support.provider?.trim() || null,
    amount: Math.min(byPercent, byKwp, cap),
    eligibleBaseIncVat,
    byPercent,
    byKwp,
    cap,
    kwp,
  };
}

export function calculate(input: CalculationInput): CalculationResult {
  if (!input || !Array.isArray(input.lines)) throw new CalculationError("Kalkylen mangler prislinjer");
  if (input.currency && input.currency !== "NOK") {
    throw new CalculationError("Denne versjonen støtter NOK", "currency");
  }
  const { panelCount } = input;
  if (!Number.isInteger(panelCount) || panelCount < 0) {
    throw new CalculationError("Panelantall må være et heltall ≥ 0", "panelCount");
  }

  const normalized = normalizeLines(input.lines);
  assertPanelCount(normalized, panelCount);

  const warnings: Warning[] = [];

  // 2. Volumrabatt
  const eligible = normalized.map((line) => (line.reductionEligible ? line.base : 0));
  const reduction = resolveReduction(input, sum(eligible), warnings);
  const shares = allocate(reduction.amount, eligible);

  // 3. Påslag / fast salgsbeløp
  const lines: CalculatedLine[] = normalized.map((line, index) => {
    const reducedBase = line.base - shares[index];
    const automaticSale = sum([reducedBase, percentOf(reducedBase, line.markupPercent, "markup")]);
    const isFixed = line.priceMode === "fixed";
    const sale = isFixed ? toOre(line.fixedSale!, `lines.${index}.fixedSale`) : automaticSale;

    if (isFixed && shares[index] > 0) {
      warnings.push({
        code: "FIXED_SALE",
        message: `${line.name}: fast salgsbeløp beholdes etter volumreduksjon.`,
        blocking: false,
      });
    }
    if (isFixed && line.quantity === 0 && sale > 0) {
      throw new CalculationError("En linje med null mengde kan ikke ha salgsbeløp", "lines");
    }

    return { ...line, reduction: shares[index], reducedBase, automaticSale, sale, markupAmount: sale - reducedBase };
  });

  // 4–5. Sum og kommisjon
  const subtotal = sum(lines.map((line) => line.sale));
  const commission = resolveCommission(input, subtotal);

  // 6. Mva.
  const totalExVat = sum([subtotal, commission.amount]);
  const vatPercent = nonNegative(input.vatPercent ?? 25, "vatPercent");
  if (vatPercent > 100) throw new CalculationError("Ugyldig mva-sats", "vatPercent");
  const vat = percentOf(totalExVat, vatPercent, "vat");
  const totalIncVat = sum([totalExVat, vat]);

  // 7. Støtte (bare visning – endrer ikke faktura, mva. eller kommisjon)
  const supportResult = resolveSupport(input, lines, subtotal, totalExVat, vatPercent);
  const support = supportResult.amount;
  if (support > totalIncVat) throw new CalculationError("Støttebeløpet overstiger kundeprisen", "support");

  const supplierCost = sum(lines.filter((line) => line.kind === "product").map((line) => line.reducedBase));

  return {
    engineVersion: ENGINE_VERSION,
    currency: input.currency ?? "NOK",
    panelCount,
    lines,
    reduction,
    commission,
    totals: {
      base: sum(lines.map((line) => line.base)),
      subtotal,
      markup: sum(lines.map((line) => line.markupAmount)),
      totalExVat,
      vat,
      totalIncVat,
      support,
      afterSupport: totalIncVat - support,
      supplierCost,
      installerRemaining: subtotal - supplierCost,
    },
    support: supportResult,
    warnings,
    ready: !warnings.some((warning) => warning.blocking),
  };
}
