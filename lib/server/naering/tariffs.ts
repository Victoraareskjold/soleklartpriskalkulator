import "server-only";
// Tariffregisteret: felles tariffer (team_id null, vedlikeholdes av oss) og teamets egne.
// Egne tariffer kan redigeres så lenge de ikke er brukt i et sendt tilbud; ellers lages en kopi.
// Sletting av brukte tariffer blir arkivering, så analyser og historikk bevares.
import { z } from "zod";
import { sql } from "@/lib/server/db";

export interface TariffRow {
  id: string;
  team_id: string | null;
  code: string | null;
  grid_owner: string;
  name: string;
  customer_group: string;
  valid_from: Date;
  valid_to: Date | null;
  definition: Record<string, unknown>;
  source_url: string | null;
  last_checked: Date;
  is_manual: boolean;
  archived_at: Date | null;
  parent_id: string | null;
  created_at: Date;
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export async function tariffUsage(id: string) {
  const [u] = await sql<{ analyses: number; locked: number }[]>`
    select
      (select count(*)::int from calc.business_analyses where settings->'meteringPoint'->>'tariffId' = ${id}) as analyses,
      (select count(*)::int from calc.business_runs where locked_at is not null and input_snapshot->'meta'->'tariff'->>'id' = ${id}) as locked`;
  return u;
}

export const tariffDto = (t: TariffRow, teamId: string, usage?: { analyses: number; locked: number }) => ({
  id: t.id,
  gridOwner: t.grid_owner,
  name: t.name,
  customerGroup: t.customer_group,
  validFrom: day(t.valid_from),
  validTo: day(t.valid_to),
  definition: t.definition,
  sourceUrl: t.source_url,
  lastChecked: day(t.last_checked),
  isManual: t.is_manual,
  /** felles = vedlikeholdes sentralt (kan kopieres), egen = teamets (kan redigeres/slettes) */
  owner: t.team_id == null ? ("felles" as const) : t.team_id === teamId ? ("egen" as const) : ("annen" as const),
  archived: t.archived_at != null,
  parentId: t.parent_id,
  usage: usage ?? null,
});

const nok = z.number().min(0).max(10_000_000);
export const tariffInputSchema = z.object({
  gridOwner: z.string().trim().min(1, "Nettselskap mangler").max(120),
  name: z.string().trim().min(1, "Tariffnavn mangler").max(160),
  customerGroup: z.string().trim().max(120).default("Næring"),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable().default(null),
  sourceUrl: z.url().nullable().default(null),
  definition: z.object({
    fixedNokPerYear: nok,
    fixedAllocation: z.enum(["per_dag", "per_måned"]).default("per_dag"),
    energyOrePerKwh: z.number().min(0).max(500),
    power: z
      .object({
        method: z.literal("maks_time_i_vindu"),
        window: z.object({
          weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
          fromHour: z.number().int().min(0).max(23),
          toHour: z.number().int().min(1).max(24),
          excludeHolidays: z.boolean(),
        }),
        summerMonths: z.array(z.number().int().min(1).max(12)).max(12),
        summerNokPerKwMonth: nok,
        winterNokPerKwMonth: nok,
      })
      .nullable()
      .default(null),
    rateChanges: z
      .array(
        z.object({
          from: z.iso.date(),
          energyOrePerKwh: z.number().min(0).max(500).optional(),
          summerNokPerKwMonth: nok.optional(),
          winterNokPerKwMonth: nok.optional(),
          source: z.string().max(300).default("Registrert manuelt"),
          status: z.enum(["målt", "beregnet", "antatt"]).default("antatt"),
        }),
      )
      .max(12)
      .default([]),
    minAnnualKwh: z.number().min(0).nullable().default(null),
    maxAnnualKwh: z.number().min(0).nullable().default(null),
    includedNote: z.string().max(300).default(""),
    notes: z.array(z.string().max(300)).max(10).default([]),
  }),
});

export const cleanDefinition = (d: z.infer<typeof tariffInputSchema>["definition"]) => ({ ...d, power: d.power ?? undefined });
