// Innstillingene for en næringsanalyse slik dashboardet lagrer dem (calc.business_analyses.settings).
// Alle felt har standardverdier, så et tomt objekt gir et gyldig raskt estimat.
// Standardverdiene for økonomi er Asbjørns foreløpige forslag (21.10.2026) – alle kan endres.

import { z } from "zod";

export const BUSINESS_TYPES = ["kontor", "butikk", "lager", "verksted", "landbruk", "døgnkontinuerlig"] as const;
export const GOALS = ["lavere_regning", "egenbruk", "effekt", "lading", "nødstrøm"] as const;
export const PRICE_AREAS = ["NO1", "NO2", "NO3", "NO4", "NO5"] as const;
const status = z.enum(["målt", "beregnet", "antatt"]);

const year = z.number().int().min(2022).max(2100);
const hour = z.number().int().min(0).max(24);

export const surfaceSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().max(80).default(""),
  /** Antall paneler på flaten (fra solkartet). Brukes til å fordele kalkylens kWp. */
  panels: z.number().int().min(0).max(100_000).nullable().default(null),
  /** Fast kWp for flaten. null = fordel kalkylens kWp etter panelantall. */
  kwp: z.number().min(0).max(100_000).nullable().default(null),
  tiltDeg: z.number().min(0).max(90),
  /** Asimut fra nord: 180 = sør, 90 = øst, 270 = vest */
  azimuthDeg: z.number().min(0).max(360),
});

export const settingsSchema = z.object({
  businessType: z.enum(BUSINESS_TYPES).default("kontor"),
  /** Driftstid [fra, til) lokal time. null = typisk for virksomhetstypen. */
  openHours: z.tuple([hour, hour]).nullable().default(null),
  goals: z.array(z.enum(GOALS)).max(5).default(["lavere_regning"]),
  period: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("år"), year }),
      z.object({ kind: z.literal("hittil"), year, toMonth: z.number().int().min(1).max(12), toDay: z.number().int().min(1).max(31) }),
    ])
    .prefault(() => ({ kind: "år" as const, year: new Date().getFullYear() - 1 })),
  location: z
    .object({
      address: z.string().max(300).default(""),
      lat: z.number().min(57).max(72).nullable().default(null),
      lon: z.number().min(4).max(32).nullable().default(null),
      priceArea: z.enum(PRICE_AREAS).nullable().default(null),
      /** foreslått = fra adressen (kontroller), valgt = satt av selger */
      priceAreaSource: z.enum(["foreslått", "valgt"]).default("foreslått"),
    })
    .prefault({}),
  consumption: z
    .object({
      /** 1 = standardprofil fra årsforbruk, 2 = månedsforbruk, 3 = målte timer/kvarter (aktiv opplastet serie) */
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
      annualKwh: z.number().min(0).max(1e9).nullable().default(null),
      annualKwhStatus: status.default("antatt"),
      monthlyKwh: z.array(z.number().min(0).max(1e8)).length(12).nullable().default(null),
    })
    .prefault({}),
  production: z
    .object({
      source: z.enum(["pvgis", "fil"]).default("pvgis"),
      /** auto = PVGIS 6 for værår etter 2023, ellers 5.3 (fall tilbake til 5.3 hvis 6 feiler) */
      pvgisVersion: z.enum(["auto", "v5_3", "v6"]).default("auto"),
      /** null = samme år som analysen når PVGIS har det */
      weatherYear: z.number().int().min(2005).max(2100).nullable().default(null),
      lossPct: z.number().min(0).max(50).default(14),
      surfaces: z.array(surfaceSchema).max(30).default([]),
    })
    .prefault({}),
  meteringPoint: z
    .object({
      id: z.string().max(40).default("mp1"),
      label: z.string().max(80).default("Hovedmåler"),
      meterId: z.string().max(40).default(""),
      tariffId: z.uuid().nullable().default(null),
      exportLimitKw: z.number().min(0).max(100_000).nullable().default(null),
      buy: z
        .object({ markupOrePerKwh: z.number().min(-100).max(500).default(0), monthlyFeeNok: z.number().min(0).max(100_000).default(0), status: status.default("antatt") })
        .prefault({}),
      sell: z.object({ deductionOrePerKwh: z.number().min(-100).max(500).default(0), status: status.default("antatt") }).prefault({}),
      elavgift: z
        .object({
          orePerKwh: z.number().min(0).max(100).nullable().default(null),
          taxStatus: z.enum(["ordinær", "redusert", "ukjent"]).default("ukjent"),
          status: status.default("antatt"),
        })
        .prefault({}),
    })
    .prefault({}),
  economy: z
    .object({
      years: z.number().int().min(1).max(50).default(30),
      discountRatePct: z.number().min(0).max(30).default(8.12),
      growth: z
        .object({
          kraftPct: z.number().min(-10).max(20).default(3.5),
          nettleiePct: z.number().min(-10).max(20).default(2),
          avgiftPct: z.number().min(-10).max(20).default(0),
          driftPct: z.number().min(-10).max(20).default(2),
        })
        .prefault({}),
      degradationPct: z.number().min(0).max(5).default(0.4),
      opex: z.array(z.object({ name: z.string().max(80), nokPerYear: z.number().min(0).max(1e8) })).max(20).default([{ name: "Service", nokPerYear: 2500 }]),
      replacements: z
        .array(z.object({ name: z.string().max(120), year: z.number().int().min(1).max(50), nok: z.number().min(0).max(1e9) }))
        .max(20)
        .default([{ name: "Inverterbytte (90 000 materiell + 70 000 installasjon)", year: 15, nok: 160_000 }]),
      investment: z
        .object({
          /** kalkyle = tilbudets sum eks. mva. for solcelleanlegget (uten batteritillegg) */
          source: z.enum(["kalkyle", "manuell", "uavklart"]).default("kalkyle"),
          nok: z.number().min(0).max(1e10).nullable().default(null),
        })
        .prefault({}),
    })
    .prefault({}),
  scenarios: z
    .array(z.object({ name: z.string().max(80), kraftGrowthPct: z.number().min(-10).max(20) }))
    .min(1)
    .max(5)
    .default([
      { name: "Hovedscenario: strømpris +3,5 %/år", kraftGrowthPct: 3.5 },
      { name: "Forsiktig: ingen strømprisvekst", kraftGrowthPct: 0 },
    ]),
});

export type BusinessSettings = z.infer<typeof settingsSchema>;
export type Surface = z.infer<typeof surfaceSchema>;

/** Prisområde foreslått fra fylkesnummer (grovt – grensene følger ikke fylkene helt). */
export function priceAreaFromCounty(countyNo: string): (typeof PRICE_AREAS)[number] | null {
  const map: Record<string, (typeof PRICE_AREAS)[number]> = {
    "03": "NO1", "31": "NO1", "32": "NO1", "33": "NO1", "34": "NO1", "39": "NO1",
    "40": "NO2", "42": "NO2", "11": "NO2",
    "46": "NO5",
    "15": "NO3", "50": "NO3",
    "18": "NO4", "55": "NO4", "56": "NO4",
  };
  return map[countyNo] ?? null;
}
