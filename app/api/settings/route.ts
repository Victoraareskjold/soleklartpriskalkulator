import { z } from "zod";
import { validateTiers } from "@/lib/engine";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { loadSettings } from "@/lib/server/settings";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { kroner, percent, tiers } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z
  .object({
    commissionTiers: tiers,
    noPanelCommissionPercent: percent(),
    vatPercent: percent(),
    inverterSizingFactor: z.coerce.number().gt(0, "Må være større enn 0").max(5),
    supportName: z.string().trim().min(1).max(80),
    supportEnabled: z.boolean(),
    supportPercent: percent(),
    supportPerKwp: kroner,
    supportMaxKwp: z.coerce.number().min(0).max(100000),
    supportMax: kroner,
    mountSupportEligible: z.boolean(),
    defaultBatteryClass: z.enum(["HV", "LV"]),
    hybridDcRatio: z.coerce.number().gt(0).max(5),
    economyElPricePrivate: z.coerce.number().min(0).max(20),
    economyNetPricePrivate: z.coerce.number().min(0).max(20),
    economyElPriceBusiness: z.coerce.number().min(0).max(20),
    economyNetPriceBusiness: z.coerce.number().min(0).max(20),
    economyPriceGrowthPercent: z.coerce.number().min(-20).max(50),
    /** Foretrukne leverandører og merker per type */
    preferences: z.record(
      z.enum(["inverter", "hybrid", "panel", "battery"]),
      z.object({ supplierIds: z.array(z.uuid()).max(50).default([]), brands: z.array(z.string().trim().min(1).max(60)).max(20).default([]) }),
    ),
    /** Standard for batteridelen av nye tilbud */
    batteryDefaults: z.object({
      offerEnabled: z.boolean().optional(),
      models: z.array(z.uuid()).max(100).optional(),
      hybridCommission: z.object({ mode: z.enum(["auto", "percent", "amount"]), value: z.coerce.number().min(0).max(1_000_000).nullish() }).nullish(),
    }),
    /** Forutsetninger i tilbudets økonomiberegning. Sendes samlet. */
    offerAssumptions: z.object({
      exportPrice: z.coerce.number().min(0).max(20),
      selfUsePercent: z.coerce.number().min(1).max(100).nullable(),
      degradationPercent: z.coerce.number().min(0).max(5),
      replacementYear: z.coerce.number().int().min(1).max(30),
      replacementFactor: z.coerce.number().min(0).max(5),
      maintenancePerYear: z.coerce.number().min(0).max(1_000_000),
      consumptionFallback: z.coerce.number().int().min(500).max(1_000_000),
      periodYears: z.union([z.literal(10), z.literal(20), z.literal(30)]),
      productWarrantyYears: z.coerce.number().int().min(0).max(60),
      powerWarrantyYears: z.coerce.number().int().min(0).max(60),
      expectedLifetimeYears: z.coerce.number().int().min(1).max(80),
    }).partial(),
  })
  .partial();

/** Sentrale regler for teamet: provisjon, mva., invertervalg, støtte, batteri og standardverdier for tilbud. Bare feltene som sendes, endres. */
export const PUT = handler(async (req) => {
  const access = await requireAccess(req);
  const teamId = adminTeamId(access);
  const input = await body(req, schema);

  const columns: Record<string, unknown> = { updated_by: access.userId };
  if (input.noPanelCommissionPercent !== undefined) columns.no_panel_commission_percent = input.noPanelCommissionPercent;
  if (input.vatPercent !== undefined) columns.vat_percent = input.vatPercent;
  if (input.inverterSizingFactor !== undefined) columns.inverter_sizing_factor = input.inverterSizingFactor;
  if (input.supportName !== undefined) columns.support_name = input.supportName;
  if (input.supportEnabled !== undefined) columns.support_enabled = input.supportEnabled;
  if (input.supportPercent !== undefined) columns.support_percent = input.supportPercent;
  if (input.supportPerKwp !== undefined) columns.support_per_kwp_ore = input.supportPerKwp;
  if (input.supportMaxKwp !== undefined) columns.support_max_kwp = input.supportMaxKwp;
  if (input.supportMax !== undefined) columns.support_max_ore = input.supportMax;
  if (input.mountSupportEligible !== undefined) columns.mount_support_eligible = input.mountSupportEligible;
  if (input.defaultBatteryClass !== undefined) columns.default_battery_class = input.defaultBatteryClass;
  if (input.hybridDcRatio !== undefined) columns.hybrid_dc_ratio = input.hybridDcRatio;
  if (input.economyElPricePrivate !== undefined) columns.economy_el_price_private = input.economyElPricePrivate;
  if (input.economyNetPricePrivate !== undefined) columns.economy_net_price_private = input.economyNetPricePrivate;
  if (input.economyElPriceBusiness !== undefined) columns.economy_el_price_business = input.economyElPriceBusiness;
  if (input.economyNetPriceBusiness !== undefined) columns.economy_net_price_business = input.economyNetPriceBusiness;
  if (input.economyPriceGrowthPercent !== undefined) columns.economy_price_growth_percent = input.economyPriceGrowthPercent;
  if (input.preferences !== undefined) columns.preferences = asJson(input.preferences);
  if (input.batteryDefaults !== undefined) columns.battery_defaults = asJson(input.batteryDefaults);
  if (input.offerAssumptions !== undefined) columns.offer_assumptions = asJson(input.offerAssumptions);

  const sorted = input.commissionTiers ? validateTiers(input.commissionTiers, "commissionTiers") : null;
  if (sorted?.some((t) => t.min < 1)) throw new HttpError(400, "Provisjonstrinn starter på minst 1 panel", "BAD_REQUEST");

  await sql.begin(async (tx) => {
    await tx`insert into calc.settings (team_id) values (${teamId}) on conflict (team_id) do nothing`;
    await tx`update calc.settings set ${sql(columns)} where team_id = ${teamId}`;
    if (sorted) {
      await tx`delete from calc.commission_tiers where team_id = ${teamId}`;
      for (const tier of sorted) {
        await tx`
          insert into calc.commission_tiers (team_id, from_panels, to_panels, percent)
          values (${teamId}, ${tier.min}, ${tier.max}, ${Number(tier.percent)})`;
      }
    }
  });
  // Svarer med det som faktisk er lagret, så dashboardet kan se at endringen ble tatt imot
  return { ok: true, saved: Object.keys(input), settings: await loadSettings(teamId) };
});
