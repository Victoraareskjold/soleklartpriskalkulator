// Batteritillegg: hybridvalg, mellomlegg, påslag og Soleklart-sats (Asbjørns merknader 17.10.2026).
import { describe, expect, it } from "vitest";
import { calculate } from "@/lib/engine";
import { planBatteryOffer, type OfferContext, type OfferProduct } from "./battery";

const p = (id: string, name: string, kr: number, productKind: string, specs: Record<string, unknown>, supplier = "Nordic"): OfferProduct => ({
  id, name, priceOre: kr * 100, specs, attachmentUrl: `https://x/${id}.pdf`, active: true, productKind, supplier,
});

const products = [
  p("deye15", "Deye 15kW", 9000, "inverter", { acKw: 15, grid: "230", phases: 3, hybrid: false }),
  p("sunsynk115", "SunSynk HV 11.5kW", 23000, "inverter", { acKw: 11.5, grid: "230", hybrid: true, batteryClass: "HV" }, "STS"),
  p("sunsynk145", "SunSynk HV 14,5kW", 26000, "inverter", { acKw: 14.5, grid: "230", hybrid: true, batteryClass: "HV" }, "STS"),
  p("solis8", "Solis HYBRID 8kW", 19360, "inverter", { acKw: 8, grid: "230", hybrid: true, batteryClass: "HV" }),
  p("solislv10", "SOLIS S6-EH3P 10kW -H-LV 230V", 19986, "inverter", { acKw: 10, grid: "230", hybrid: true, batteryClass: "LV" }),
  p("sunsynk20", "SunSynk HV 20kW", 26700, "inverter", { acKw: 20, grid: "400", hybrid: true, batteryClass: "HV" }),
  p("enermod", "Enershare Batterimodul 3,2 kW", 6290, "batteri", { capacityKwh: 3.2, batteryClass: "HV" }),
  p("enerbms", "Enershare BMS", 5100, "batteri", { batteryClass: "HV" }),
  p("fel10", "Felicity LV 10.24kWt", 24080, "batteri", { capacityKwh: 10.24, batteryClass: "LV" }),
];

const ctx = (extra: Partial<OfferContext> = {}): OfferContext => ({
  products,
  batteryWork: [{ id: "uten", name: "Uten backup", priceOre: 800_000, active: true }],
  markups: { solcellemateriell: 10, elektro: 32 },
  settings: { defaultBatteryClass: "HV", hybridDcRatio: 1.5, noPanelCommissionPercent: 25 },
  grid: "230",
  kwp: 16.56,
  ...extra,
});

// Grunnkalkyle: stringinverter + resten, 24 % Soleklart
const result = (inverterId = "deye15", inverterKr = 9000) =>
  calculate({
    panelCount: 0,
    reduction: { mode: "percent", value: 0 },
    commission: { mode: "percent", value: 24 },
    lines: [
      { id: "inv", name: "Inverter", kind: "product", productKind: "inverter", quantity: 1, baseUnit: inverterKr, markupPercent: 10, meta: { sourceId: inverterId } },
      { id: "rest", name: "Resten", kind: "product", quantity: 1, baseUnit: 90_000, markupPercent: 0 },
    ],
  });

describe("hybridalternativ", () => {
  it("velger rimeligste HV-hybrid for 230 V som tåler 16,56 kWp og ikke er større enn stringinverteren", () => {
    const o = planBatteryOffer({}, ctx(), result());
    // 8 kW × 1,5 = 12 kWp < 16,56 → for liten. 11,5 × 1,5 = 17,25 → ok og rimeligst.
    expect(o.hybrid?.productId).toBe("sunsynk115");
    expect(o.hybrid?.auto).toBe(true);
  });

  it("mellomlegget = hybrid med påslag − stringinverter i grunnpakken, så Soleklart-sats", () => {
    const o = planBatteryOffer({}, ctx(), result());
    // (23 000 × 1,10) − (9 000 × 1,10) = 15 400 kr før Soleklart, × 1,24 = 19 096 kr
    expect(o.upgrade.saleOre).toBe(1_540_000);
    expect(o.upgrade.customerOre).toBe(1_909_600);
    expect(o.section?.hybridUnitEx).toBe(19_096);
    expect(o.commissionRate).toBeCloseTo(0.24, 6);
  });

  it("LV-batteri gir LV-hybrid, 400 V gir 400 V-hybrid, og for lite PV-kapasitet gir varsel", () => {
    // 10 kW × 1,5 = 15 kWp: for lite for 16,56 kWp, men nok for 14 kWp
    const tooSmall = planBatteryOffer({ batteryClass: "LV" }, ctx(), result());
    expect(tooSmall.hybrid).toBeNull();
    expect(tooSmall.warnings.join(" ")).toMatch(/Fant ingen hybridinverter/);
    expect(planBatteryOffer({ batteryClass: "LV" }, ctx({ kwp: 14 }), result()).hybrid?.productId).toBe("solislv10");
    expect(planBatteryOffer({}, ctx({ grid: "400" }), result()).hybrid?.productId).toBe("sunsynk20");
  });

  it("hybrid allerede i grunnpakken prises ikke en gang til", () => {
    const o = planBatteryOffer({}, ctx(), result("sunsynk145", 26000));
    expect(o.hybridIncluded).toBe(true);
    expect(o.upgrade.customerOre).toBe(0);
    expect(o.section?.hybridIncluded).toBe(true);
  });

  it("manuelt valgt hybrid brukes", () => {
    const o = planBatteryOffer({ hybridProductId: "sunsynk145" }, ctx(), result());
    expect(o.hybrid?.productId).toBe("sunsynk145");
    expect(o.hybrid?.auto).toBe(false);
  });
});

describe("batterimodeller", () => {
  it("innkjøp + installatørens påslag (solcellemateriell) + Soleklart; BMS koblet på samme merke", () => {
    const o = planBatteryOffer({}, ctx(), result());
    const ener = o.models.find((m) => m.productId === "enermod")!;
    expect(ener.structure).toBe("modular");
    expect(ener.module.purchaseOre).toBe(629_000);
    expect(ener.module.saleOre).toBe(691_900); // +10 %
    expect(ener.module.customerOre).toBe(857_956); // × 1,24
    expect(ener.bms?.name).toBe("Enershare BMS");
    expect(ener.enabled).toBe(true);
    // LV-modellen er ikke med når HV er standard
    expect(o.models.find((m) => m.productId === "fel10")!.enabled).toBe(false);
    expect(o.section?.catalogue).toHaveProperty("enermod");
  });

  it("påslag og BMS-pris kan overstyres per tilbud", () => {
    const o = planBatteryOffer({ markupPercent: "20", models: [{ productId: "enermod", bmsPrice: "4000" }] }, ctx(), result());
    const ener = o.models.find((m) => m.productId === "enermod")!;
    expect(o.materialMarkupPercent).toBe(20);
    expect(ener.module.saleOre).toBe(754_800);
    expect(ener.bms?.purchaseOre).toBe(400_000);
    expect(ener.bms?.overridden).toBe(true);
  });

  it("installasjon: avtalt sats + elektro-påslag + Soleklart", () => {
    const o = planBatteryOffer({}, ctx(), result());
    expect(o.install?.saleOre).toBe(1_056_000); // 8 000 × 1,32
    expect(o.install?.customerOre).toBe(1_309_440); // × 1,24
  });
});

import { signedBreakdown } from "./signed";

describe("signert tilbud", () => {
  it("endelig kommisjon = grunnpakkens + Soleklart på hybrid, batteri, BMS og installasjon", () => {
    const base = result();
    const o = planBatteryOffer({}, ctx(), base);
    const b = signedBreakdown(base, o, { mode: "battery", model: "enermod", modules: 10 });
    expect(b.capacityKwh).toBe(32);
    const labels = b.extras.map((l) => l.label);
    expect(labels[0]).toMatch(/Oppgradering til hybridinverter/);
    expect(labels.some((l) => /Enershare BMS × 2/.test(l))).toBe(true); // 10 moduler, 8 per BMS → 2
    expect(b.commissionOre).toBe(base.commission.amount + b.extrasSoleklartOre);
    expect(b.totalExVatOre).toBe(base.totals.totalExVat + b.extrasCustomerOre);
    // Kundeprisen per linje = salg × 1,24
    for (const l of b.extras) expect(l.customerOre).toBe((l.saleOre ?? 0) + (l.soleklartOre ?? 0));
  });

  it("uten valg er det bare grunnpakken", () => {
    const base = result();
    const b = signedBreakdown(base, planBatteryOffer({}, ctx(), base), null);
    expect(b.extras).toHaveLength(0);
    expect(b.commissionOre).toBe(base.commission.amount);
  });
});
