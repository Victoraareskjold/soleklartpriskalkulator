// Typer for smart-batteri.js (Nordic Solergy AS). Fila selv er urørt; se SMART-BATTERI-BESKRIVELSE.md.
// Bare det vi bruker er typet. Rutenettet er 8760 timer (1. januar kl. 00 = indeks 0, uten 29. februar).

export interface Innstillinger {
  virkningsgrad: number;
  margin: number;
  horisont: number;
  brukTimer: number;
  startNivaa: number;
  spredning: number;
  syklusStraff: number;
  takStraff: number;
  takForsok: number;
  minTrinn: number;
  maksTrinn: number;
}

/** Effekttariff (høyeste time i måneden × sats) eller kapasitetstrinn (snitt av tre døgntopper → trinnpris). */
export type SbTariff =
  | {
      type: "effekt";
      energiFlat?: number;
      energiVinter?: number;
      energiSommer?: number;
      effektVinter: number;
      effektSommer: number;
      fastledd?: number;
      vinterMnd?: { includes(m: number): boolean };
    }
  | { type: "trinn"; energiDag?: number; energiNatt?: number; trinn: [number, number | null, number][] };

export interface PlanInput {
  net: ArrayLike<number>;
  kjop: ArrayLike<number>;
  salg: ArrayLike<number>;
  kap: number;
  kw?: number;
  tariff?: SbTariff | null;
  mvaF?: number;
  nivaa?: number;
}

export interface Plan {
  /** kWh inn i (+) eller ut av (−) batteriet på nettsiden, 8760 timer */
  ac: Float64Array;
  /** Valgt tak per måned (kW), Infinity = intet tak */
  tak: number[];
  kost: number;
}

export interface EffektMnd {
  kw: number;
  kr: number;
  fast: number;
  maks: number;
  tre: number[];
}

export interface SimulerInput {
  forbruk: ArrayLike<number>;
  sol?: ArrayLike<number> | null;
  kjop: ArrayLike<number>;
  salg: ArrayLike<number>;
  kapKwh: number;
  kw?: number;
  smart?: boolean;
  tariff?: SbTariff | null;
  mvaF?: number;
  nett?: number | ArrayLike<number>;
}

export interface SimulerResultat {
  timer: { import: Float64Array; eksport: Float64Array; ladNett: Float64Array; battUt: Float64Array; ac: Float64Array | null };
  plan: Plan | null;
  sum: Record<string, number>;
  okonomi: { regningFor: number; regningEtter: number; energiSpart: number; effektSpart: number; salg: number; gevinst: number };
}

declare const SmartBatteri: {
  INNSTILLINGER: Innstillinger;
  DAG_FOR_MND: number[];
  mndFraIndeks(i: number): number;
  effektMnd(timer: ArrayLike<number>, m: number, tariff: SbTariff, mvaF: number): EffektMnd;
  planlegg(o: PlanInput): Plan;
  simuler(o: SimulerInput): SimulerResultat;
};
export default SmartBatteri;
