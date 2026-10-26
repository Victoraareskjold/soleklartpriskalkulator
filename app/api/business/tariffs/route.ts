import { z } from "zod";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

interface TariffRow {
  id: string;
  team_id: string | null;
  grid_owner: string;
  name: string;
  customer_group: string;
  valid_from: Date;
  valid_to: Date | null;
  definition: unknown;
  source_url: string | null;
  last_checked: Date;
  is_manual: boolean;
}
const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const dto = (t: TariffRow) => ({
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
});

/** Tariffregisteret: felles tariffer + teamets manuelt registrerte. */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const installer = await requireInstallerAccess(access, new URL(req.url).searchParams.get("installerGroupId"));
  const rows = await sql<TariffRow[]>`
    select * from calc.tariffs where team_id is null or team_id = ${installer.teamId}
    order by grid_owner, valid_from desc, name`;
  return { tariffs: rows.map(dto) };
});

const nok = z.number().min(0).max(10_000_000);
const schema = z.object({
  installerGroupId: uuid,
  gridOwner: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
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
    notes: z.array(z.string().max(300)).max(10).default([]),
  }),
});

/** Registrer tariff og satser manuelt (gjelder teamet). Brukes når tariffen ikke finnes i registeret. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, schema);
  const installer = await requireInstallerAccess(access, input.installerGroupId);
  const definition = { ...input.definition, power: input.definition.power ?? undefined };
  const [row] = await sql<TariffRow[]>`
    insert into calc.tariffs (team_id, grid_owner, name, customer_group, valid_from, valid_to, definition, source_url, last_checked, is_manual, created_by)
    values (${installer.teamId}, ${input.gridOwner}, ${input.name}, ${input.customerGroup}, ${input.validFrom}, ${input.validTo},
            ${asJson(definition)}, ${input.sourceUrl}, current_date, true, ${access.userId})
    returning *`;
  return dto(row);
});
