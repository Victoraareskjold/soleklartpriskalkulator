// Intern oppstilling av et signert tilbud: grunnpakken + det kunden valgte (hybrid, batteri),
// med innkjøp, installatørens påslag og Soleklart-kommisjon. Regnes fra låste data
// (versjonens batterioppsett + kundens lagrede valg), så resultatet er det samme hver gang.
import type { CalculationResult } from "@/lib/engine";
import type { BatteryOfferResult } from "./battery";

export interface Selection {
  mode?: "solar" | "hybrid" | "battery";
  model?: string | null;
  modules?: number;
  backup?: string;
  circuits?: number;
}

export interface BreakdownLine {
  label: string;
  quantity: number;
  /** Innkjøp / avtalt sats (øre, eks. mva.) */
  purchaseOre: number | null;
  /** Installatørens påslag (øre) */
  installerMarkupOre: number | null;
  /** Etter påslag, før Soleklart (øre) */
  saleOre: number | null;
  /** Soleklart-kommisjon på linjen (øre) */
  soleklartOre: number | null;
  /** Kundepris eks. mva. (øre) */
  customerOre: number;
}

export function signedBreakdown(base: CalculationResult, offer: BatteryOfferResult | null, selection: Selection | null) {
  const lines: BreakdownLine[] = [];
  const add = (label: string, quantity: number, step: { purchaseOre: number; saleOre: number; customerOre: number }) =>
    lines.push({
      label,
      quantity,
      purchaseOre: step.purchaseOre * quantity,
      installerMarkupOre: (step.saleOre - step.purchaseOre) * quantity,
      saleOre: step.saleOre * quantity,
      soleklartOre: (step.customerOre - step.saleOre) * quantity,
      customerOre: step.customerOre * quantity,
    });

  const mode = selection?.mode ?? "solar";
  if (offer && mode !== "solar" && !offer.hybridIncluded && offer.hybrid) {
    lines.push({
      label: `Oppgradering til hybridinverter: ${offer.hybrid.name} (erstatter ${offer.stringInverter?.name ?? "stringinverter"})`,
      quantity: 1,
      purchaseOre: offer.hybrid.purchaseOre,
      installerMarkupOre: offer.hybrid.saleOre - offer.hybrid.purchaseOre,
      // Mellomlegget: hybrid med påslag minus stringinverteren slik den står i grunnpakken
      saleOre: offer.upgrade.saleOre,
      soleklartOre: offer.upgrade.customerOre - offer.upgrade.saleOre,
      customerOre: offer.upgrade.customerOre,
    });
  }

  let capacityKwh = 0;
  if (offer && mode === "battery" && selection?.model) {
    const model = offer.models.find((m) => m.productId === selection.model);
    if (model) {
      const modules = Math.max(model.min, Math.min(model.max, Math.round(selection.modules ?? model.min)));
      capacityKwh = Number((modules * model.moduleKwh).toFixed(2));
      add(`${model.name} × ${modules}`, modules, model.module);
      if (model.bms) {
        const count = Math.ceil(modules / model.modulesPerBms);
        add(`${model.bms.name} × ${count}`, count, model.bms);
      }
      if (offer.install) add(offer.install.name || "Installasjon av batteri", 1, offer.install);
    }
  }

  const sum = (key: keyof BreakdownLine) => lines.reduce((s, l) => s + (Number(l[key]) || 0), 0);
  const extrasCustomer = sum("customerOre");
  const extrasSoleklart = sum("soleklartOre");
  const vatRate = base.totals.totalExVat > 0 ? base.totals.vat / base.totals.totalExVat : 0.25;
  const totalExVat = base.totals.totalExVat + extrasCustomer;

  return {
    selection: { ...selection, mode },
    capacityKwh,
    base: {
      subtotalOre: base.totals.subtotal,
      supplierCostOre: base.totals.supplierCost,
      commissionOre: base.commission.amount,
      totalExVatOre: base.totals.totalExVat,
    },
    extras: lines,
    extrasCustomerOre: extrasCustomer,
    extrasSoleklartOre: extrasSoleklart,
    /** Endelig Soleklart-kommisjon: grunnpakken + tilleggene kunden valgte */
    commissionOre: base.commission.amount + extrasSoleklart,
    totalExVatOre: totalExVat,
    totalIncVatOre: Math.round(totalExVat * (1 + vatRate)),
    commissionRate: offer?.commissionRate ?? (base.totals.subtotal > 0 ? base.commission.amount / base.totals.subtotal : 0),
    materialMarkupPercent: offer?.materialMarkupPercent ?? null,
  };
}
