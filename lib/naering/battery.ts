// Batteristyring for næringsanalysen.
//
// To styringsmåter (samme batteri, samme begrensninger):
//  • grunn: lader av overskudd fra sol og dekker eget forbruk. Ingen nettlading, ikke salg fra batteriet.
//    (Regnes direkte i engine.ts, time for time.)
//  • smart: Nordic Solergy sin planlegger (nordic-solergy/smart-batteri.js, innpakket i nordic.ts).
//    Planen legges for hele perioden med dynamisk programmering over 36 timer og et tak for kjøp fra
//    nettet per måned, med kjent forbruk og sol. Motoren gjennomfører planen innenfor batteriets og
//    tilknytningens grenser.
//
// Tidligere hadde vi en egen smartstyring her (plan kl. 13 med persistensprognose). Den er erstattet av
// Nordic Solergys beregning fra 24.11.2026, så tallene våre stemmer med deres.

export interface BatteryConfig {
  /** Brukbar kapasitet i kWh (nominell × brukbar andel) som ny */
  usableKwh: number;
  /** Aldring: andel av brukbar kapasitet som er igjen (1 = ny) */
  capacityFactor?: number;
  /** Andel av brukbar kapasitet holdt igjen som nødstrømsreserve (0–1) */
  reserveShare: number;
  chargeKw: number;
  dischargeKw: number;
  /** Hybridinverterens AC-effekt som sol og batteri deler (kW). null = ikke delt / ukjent */
  sharedAcKw?: number | null;
  /** Tur-retur-virkningsgrad (0–1), fordeles likt på lading og utlading */
  roundTrip: number;
  /** Hjelpelast (styring, kjøling) i kW, hele tiden */
  auxKw: number;
  /** Tillatt å lade fra nettet */
  gridCharge: boolean;
  /** Tillatt å selge fra batteriet til nettet */
  gridExport: boolean;
  strategy: "grunn" | "smart";
  /** Brukes ikke lenger: Nordic Solergys planlegger kjenner forbruk og sol (beholdt for lagrede analyser) */
  forecast: "persistens" | "perfekt";
  /** Brukes ikke lenger: Nordic Solergys planlegger har sin egen syklusstraff (beholdt for lagrede analyser) */
  wearNokPerKwh: number;
}
