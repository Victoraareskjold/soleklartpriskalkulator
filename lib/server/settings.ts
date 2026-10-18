import "server-only";
import { sql } from "./db";

/** Foretrukne leverandører (ID) og merker (ord i produktnavnet). Tomme lister = ingen preferanse. */
export interface Preference {
  supplierIds?: string[];
  brands?: string[];
}
export type PreferenceKind = "inverter" | "hybrid" | "panel" | "battery";
export type Preferences = Partial<Record<PreferenceKind, Preference>>;

/** Forutsetninger i tilbudets økonomiberegning (utover strømpris, nettleie og prisvekst) */
export interface OfferAssumptions {
  /** Salgspris for overskuddsstrøm, kr/kWh */
  exportPrice?: number;
  /** Andel av solstrømmen kunden bruker selv, %. null = anslås automatisk */
  selfUsePercent?: number | null;
  /** Årlig produksjonsnedgang, % */
  degradationPercent?: number;
  /** År inverteren regnes som byttet */
  replacementYear?: number;
  /** Inverterbytte = inverterens pris × faktor */
  replacementFactor?: number;
  /** Faste driftskostnader per år, kr */
  maintenancePerYear?: number;
  /** Årsforbruk når verken kunden eller leaden har oppgitt det, kWh */
  consumptionFallback?: number;
  /** Perioden tilbudet viser først (10, 20 eller 30 år) */
  periodYears?: number;
}

/** Standard for batteridelen av nye tilbud */
export interface BatteryDefaults {
  /** Vis hybrid/batteri for kunden som standard */
  offerEnabled?: boolean;
  /** Batterimodeller kunden ser, i rekkefølge (produkt-ID-er). Tom = alle med valgt batteritype */
  models?: string[];
}

/** Sentrale beregningsregler for teamet. Beløp i øre. */
export interface Settings {
  noPanelCommissionPercent: number;
  vatPercent: number;
  inverterSizingFactor: number;
  supportName: string;
  supportEnabled: boolean;
  supportPercent: number;
  supportPerKwpOre: number;
  supportMaxKwp: number;
  supportMaxOre: number;
  mountSupportEligible: boolean;
  /** Standard batteritype på batterisiden av tilbudet */
  defaultBatteryClass: "HV" | "LV";
  /** Hvor mange kWp PV en hybridinverter tåler per kW AC, når maks PV ikke er oppgitt på produktet */
  hybridDcRatio: number;
  /** Standardverdier for økonomien i nye tilbud (kr/kWh og prosent) */
  economy: {
    private: { elPrice: number; netPrice: number };
    business: { elPrice: number; netPrice: number };
    priceGrowthPercent: number;
  };
  preferences: Preferences;
  batteryDefaults: BatteryDefaults;
  offerAssumptions: OfferAssumptions;
}

export const DEFAULT_SETTINGS: Settings = {
  noPanelCommissionPercent: 25,
  vatPercent: 25,
  inverterSizingFactor: 1.2,
  supportName: "Enova",
  supportEnabled: true,
  supportPercent: 25,
  supportPerKwpOre: 250000,
  supportMaxKwp: 15,
  supportMaxOre: 3750000,
  mountSupportEligible: true,
  defaultBatteryClass: "HV",
  hybridDcRatio: 1.5,
  economy: { private: { elPrice: 0.56, netPrice: 0.62 }, business: { elPrice: 0.56, netPrice: 0.62 }, priceGrowthPercent: 2.5 },
  preferences: {},
  batteryDefaults: {},
  offerAssumptions: {},
};

type SettingsRow = Omit<Settings, "economy"> & {
  elPrivate: number;
  netPrivate: number;
  elBusiness: number;
  netBusiness: number;
  growth: number;
};

export async function loadSettings(teamId: string): Promise<Settings> {
  const [row] = await sql<SettingsRow[]>`
    select no_panel_commission_percent::float8 as "noPanelCommissionPercent",
           vat_percent::float8 as "vatPercent",
           inverter_sizing_factor::float8 as "inverterSizingFactor",
           support_name as "supportName",
           support_enabled as "supportEnabled",
           support_percent::float8 as "supportPercent",
           support_per_kwp_ore::int as "supportPerKwpOre",
           support_max_kwp::float8 as "supportMaxKwp",
           support_max_ore::int as "supportMaxOre",
           mount_support_eligible as "mountSupportEligible",
           default_battery_class as "defaultBatteryClass",
           hybrid_dc_ratio::float8 as "hybridDcRatio",
           economy_el_price_private::float8 as "elPrivate",
           economy_net_price_private::float8 as "netPrivate",
           economy_el_price_business::float8 as "elBusiness",
           economy_net_price_business::float8 as "netBusiness",
           economy_price_growth_percent::float8 as "growth",
           preferences,
           battery_defaults as "batteryDefaults",
           offer_assumptions as "offerAssumptions"
    from calc.settings where team_id = ${teamId}`;
  if (!row) return DEFAULT_SETTINGS;
  const { elPrivate, netPrivate, elBusiness, netBusiness, growth, ...rest } = row;
  return {
    ...rest,
    economy: {
      private: { elPrice: elPrivate, netPrice: netPrivate },
      business: { elPrice: elBusiness, netPrice: netBusiness },
      priceGrowthPercent: growth,
    },
  };
}
