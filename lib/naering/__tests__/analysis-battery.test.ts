import { describe, expect, test } from "vitest";
import { runAnalysis, type AnalysisInput } from "../analysis";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { chargingProfile } from "../profiles";
import { buy, fakePv, sell, taxes, yearSeries } from "./helpers";
import { osloParts } from "../time";

const spot = yearSeries(2024, "pris", (t) => {
  const h = osloParts(t).hour;
  return h < 6 ? 0.25 : h >= 7 && h < 10 ? 1.2 : h >= 17 && h < 21 ? 1.4 : 0.6;
});
const base = (): AnalysisInput => ({
  project: { name: "T", address: "x", priceArea: "NO3", businessType: "kontor" },
  meteringPoint: { id: "m1", label: "Hovedmåler" },
  period: { kind: "år", year: 2024 },
  consumption: { level: 1, type: "kontor", annualKwh: 400_000 },
  production: fakePv(2024, 150),
  spot,
  tariff: T, taxes, buy, sell, exportLimitKw: null,
  weatherYear: 2024,
  economy: { investmentNok: 1_200_000, years: 30, discountRate: 0.0812, growth: { kraft: 0.035, nettleie: 0.02, avgift: 0, drift: 0.02 }, degradationPerYear: 0.004, opex: [{ name: "Service", nokPerYear: 5000 }], replacements: [] },
  scenarios: [{ name: "Hoved", kraftGrowth: 0.035 }, { name: "Forsiktig", kraftGrowth: 0 }],
});
const battery = (o: Partial<NonNullable<AnalysisInput["battery"]>> = {}): NonNullable<AnalysisInput["battery"]> => ({
  label: "Test 200 kWh",
  config: { usableKwh: 180, reserveShare: 0, chargeKw: 100, dischargeKw: 100, roundTrip: 0.9, auxKw: 0, gridCharge: true, gridExport: false, wearNokPerKwh: 0.05 },
  degradationPerYear: 0.02,
  lifeYears: 15,
  investmentNok: 600_000,
  replacementNok: 600_000,
  smartFeeNokPerYear: 12_000,
  smartFeeOnceNok: 0,
  basis: [],
  ...o,
});

describe("analyse med batteri", () => {
  const r = runAnalysis({ ...base(), battery: battery() });
  const b = r.battery!;

  test("tre alternativer med felles «før» og avstemt merverdi", () => {
    expect(b.alternatives.map((a) => a.key)).toEqual(["sol", "grunn", "smart"]);
    const [sol, grunn, smart] = b.alternatives;
    expect(sol.savings.total).toBeCloseTo(r.savings.total, 6);
    expect(b.value.grunn).toBeCloseTo(grunn.net - sol.net, 6);
    expect(b.value.smart).toBeCloseTo(smart.net - grunn.net, 6);
    // Smartstyringens gebyr er trukket fra
    expect(smart.opex - grunn.opex).toBeCloseTo(12_000, 6);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  test("investering og levetid per alternativ, med batteribytte", () => {
    const [sol, grunn, smart] = b.alternatives;
    expect(sol.investmentNok).toBe(1_200_000);
    expect(grunn.investmentNok).toBe(1_800_000);
    expect(smart.investmentNok).toBe(1_800_000);
    const rows = grunn.economy![0].result.rows;
    expect(rows[15].utskifting).toBeGreaterThanOrEqual(600_000); // år 16
    expect(rows.length).toBe(30);
    // Smartstyringen har gebyret som drift hvert år
    expect(smart.economy![0].result.rows[0].drift - grunn.economy![0].result.rows[0].drift).toBeCloseTo(12_000, 0);
  });

  test("perfekt prognose er sammenlignbar (samme styring med fasit)", () => {
    expect(b.perfectForesightNet).toBeGreaterThanOrEqual(b.alternatives[2].net * 0.99);
  });

  test("døgnutsnitt finnes og har batterinivå innenfor grensene", () => {
    expect(b.day).not.toBeNull();
    expect(b.day!.hours.length).toBeGreaterThanOrEqual(23);
    for (const h of b.day!.hours) expect(h.soc).toBeLessThanOrEqual(180 + 1e-6);
  });

  test("uten batteriinvestering: ingen nåverdi for batterialternativene", () => {
    const r2 = runAnalysis({ ...base(), battery: battery({ investmentNok: null, replacementNok: null }) });
    expect(r2.battery!.alternatives[1].investmentNok).toBeNull();
    expect(r2.battery!.alternatives[1].economy![0].result.npv).toBeNull();
  });
});

describe("flere målere, lading og mva.", () => {
  test("andre målere summeres, og solceller bak dem gir besparelse der", () => {
    const other = {
      id: "m2", label: "Lager", consumption: { level: 1 as const, type: "lager" as const, annualKwh: 200_000 },
      production: fakePv(2024, 50), tariff: T, exportLimitKw: null, importLimitKw: null,
    };
    const one = runAnalysis(base());
    const two = runAnalysis({ ...base(), otherMeters: [other] });
    expect(two.meters.length).toBe(2);
    expect(two.before.total.loadKwh).toBeCloseTo(one.before.total.loadKwh + 200_000, 0);
    expect(two.savings.total).toBeGreaterThan(one.savings.total);
    const m2 = two.meters[1];
    expect(m2.before.cost.netto - m2.after.cost.netto).toBeGreaterThan(0);
  });

  test("lading legges til forbruket i før og etter, og effektøkningen vises", () => {
    const prof = chargingProfile(2024, [{ label: "Bil", count: 4, kw: 22, kwhPerDay: 40, window: [8, 16], days: "hverdager" }]);
    const r = runAnalysis({ ...base(), extraLoad: prof });
    expect(r.charging!.kwh).toBeGreaterThan(30_000);
    expect(r.charging!.solarKwh).toBeGreaterThan(0);
    expect(r.charging!.effektleddIncrease).toBeGreaterThan(0);
    expect(r.before.total.loadKwh).toBeCloseTo(400_000 + r.charging!.kwh, 0);
  });

  test("uten fradragsrett blir kostnadene 25 % høyere, salg uendret", () => {
    const a = runAnalysis(base());
    const b = runAnalysis({ ...base(), vatFactor: 1.25 });
    expect(b.before.total.cost.kraft).toBeCloseTo(a.before.total.cost.kraft * 1.25, 3);
    expect(b.after.total.cost.salg).toBeCloseTo(a.after.total.cost.salg, 6);
  });
});
