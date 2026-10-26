// Nettleie, avgifter og strømavtaler.
// Tariffen er data (kan registreres manuelt), regnereglene er kode. Alle beløp eks. mva.

import type { Provenance } from "./types";

export interface PowerCharge {
  /** Effektgrunnlag: høyeste timeforbruk (kWh/h = kW) innenfor vinduet i måneden */
  method: "maks_time_i_vindu";
  window: { weekdays: number[]; fromHour: number; toHour: number; excludeHolidays: boolean };
  summerMonths: number[]; // 1-12
  summerNokPerKwMonth: number;
  winterNokPerKwMonth: number;
}

export interface Tariff {
  id: string;
  gridOwner: string;
  name: string;
  customerGroup: string;
  validFrom: string;
  validTo?: string;
  fixedNokPerYear: number;
  /** Fastledd fordelt per dag (Linja fakturerer slik – stemmer med kostnadsrapporten) */
  fixedAllocation: "per_dag" | "per_måned";
  energyOrePerKwh: number;
  power?: PowerCharge;
  /** Satsendringer innen gyldighetsperioden (gjelder fra og med dato, lokal tid) */
  rateChanges?: {
    from: string;
    energyOrePerKwh?: number;
    summerNokPerKwMonth?: number;
    winterNokPerKwMonth?: number;
    source: string;
    status: "målt" | "beregnet" | "antatt";
  }[];
  vat: "eks_mva";
  provenance: Provenance & { lastChecked: string; url?: string };
  notes: string[];
}

export interface Taxes {
  /** Elavgift (forbruksavgift) i øre/kWh etter kundens faktiske avgiftsstatus */
  elavgiftOrePerKwh: number;
  status: "ordinær" | "redusert" | "ukjent";
  provenance: Provenance;
}

export interface BuyAgreement {
  type: "spot";
  markupOrePerKwh: number;
  monthlyFeeNok: number;
  provenance: Provenance;
}

export interface SellAgreement {
  type: "spot";
  /** Fratrekk fra spot (positivt tall = lavere salgspris) */
  deductionOrePerKwh: number;
  provenance: Provenance;
}

/** Linja (tidl. Mørenett), prioritert lavspent forbruk > 100 000 kWh, gjeldende fra 1.1.2024. */
export const LINJA_2024_LAVSPENT_STOR: Tariff = {
  id: "linja-2024-lavspent-over-100k",
  gridOwner: "Linja AS (tidl. Mørenett)",
  name: "Prioritert lavspent forbruk over 100 000 kWh",
  customerGroup: "Næring lavspent > 100 MWh",
  validFrom: "2024-01-01",
  validTo: "2024-12-31",
  fixedNokPerYear: 8800, // inkl. Enova-påslag 800 kr – legges IKKE til igjen
  fixedAllocation: "per_dag",
  energyOrePerKwh: 7.2,
  power: {
    method: "maks_time_i_vindu",
    window: { weekdays: [1, 2, 3, 4, 5], fromHour: 6, toHour: 23, excludeHolidays: true },
    summerMonths: [4, 5, 6, 7, 8, 9],
    summerNokPerKwMonth: 31,
    winterNokPerKwMonth: 68,
  },
  rateChanges: [
    {
      from: "2024-07-01",
      summerNokPerKwMonth: 35,
      winterNokPerKwMonth: 77,
      source: "Avledet fra kostnadsrapporten 2024 (alle tre målere, juli–desember). Ikke bekreftet i tariffark.",
      status: "beregnet",
    },
  ],
  vat: "eks_mva",
  provenance: {
    status: "målt",
    source: "Linja tariffark 2024 (via Asbjørns notat)",
    lastChecked: "2026-10-21",
    url: "https://cdn.sanity.io/files/zg947p2r/production/19fdaa8dbfba0dd59d6b63fdd462787d87091537.pdf",
  },
  notes: [
    "Sommer = april–september (kildens «31. september» tolket som 30. september).",
    "Helligdager holdes utenfor effektvinduet: april 2024 stemmer bare slik (2. påskedag 1.4. ville gitt for høy topp).",
    "Effektsatsene ser ut til å ha økt fra 1.7.2024 (35/77 kr/kW). Må bekreftes mot Linjas tariffark for 2. halvår.",
    "Innmatingstariff for eksport er ikke med i trinn 1.",
  ],
};
