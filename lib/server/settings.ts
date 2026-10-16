import "server-only";
import { sql } from "./db";

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
};

export async function loadSettings(teamId: string): Promise<Settings> {
  const [row] = await sql<Settings[]>`
    select no_panel_commission_percent::float8 as "noPanelCommissionPercent",
           vat_percent::float8 as "vatPercent",
           inverter_sizing_factor::float8 as "inverterSizingFactor",
           support_name as "supportName",
           support_enabled as "supportEnabled",
           support_percent::float8 as "supportPercent",
           support_per_kwp_ore::int as "supportPerKwpOre",
           support_max_kwp::float8 as "supportMaxKwp",
           support_max_ore::int as "supportMaxOre",
           mount_support_eligible as "mountSupportEligible"
    from calc.settings where team_id = ${teamId}`;
  return row ?? DEFAULT_SETTINGS;
}
