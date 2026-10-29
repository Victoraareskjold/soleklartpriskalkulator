import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { cleanDefinition, tariffDto, tariffInputSchema, type TariffRow } from "@/lib/server/naering/tariffs";

export const OPTIONS = preflight;

/**
 * Tariffregisteret: felles tariffer + teamets egne, med bruk (analyser og sendte tilbud).
 * Arkiverte vises bare med ?includeArchived=1 (eller når de er valgt i en analyse – se ?selected=).
 */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const params = new URL(req.url).searchParams;
  const installer = await requireInstallerAccess(access, params.get("installerGroupId"));
  const includeArchived = params.get("includeArchived") === "1";
  const selected = params.get("selected");
  const rows = await sql<(TariffRow & { analyses: number; locked: number })[]>`
    select t.*,
      (select count(*)::int from calc.business_analyses a where a.team_id = ${installer.teamId} and a.settings->'meteringPoint'->>'tariffId' = t.id::text) as analyses,
      (select count(*)::int from calc.business_runs r where r.locked_at is not null and r.input_snapshot->'meta'->'tariff'->>'id' = t.id::text) as locked
    from calc.tariffs t
    where (t.team_id is null or t.team_id = ${installer.teamId})
      and (${includeArchived} or t.archived_at is null or t.id::text = ${selected ?? ""})
    order by t.archived_at nulls first, t.grid_owner, t.valid_from desc, t.name`;
  return { tariffs: rows.map((t) => tariffDto(t, installer.teamId, { analyses: t.analyses, locked: t.locked })) };
});

/** Registrer tariff manuelt (gjelder teamet), f.eks. fra kundens nettleiefaktura. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, tariffInputSchema.extend({ installerGroupId: uuid, parentId: uuid.nullable().optional() }));
  const installer = await requireInstallerAccess(access, input.installerGroupId);
  const [row] = await sql<TariffRow[]>`
    insert into calc.tariffs (team_id, grid_owner, name, customer_group, valid_from, valid_to, definition, source_url, last_checked, is_manual, parent_id, created_by, updated_by)
    values (${installer.teamId}, ${input.gridOwner}, ${input.name}, ${input.customerGroup}, ${input.validFrom}, ${input.validTo},
            ${asJson(cleanDefinition(input.definition))}, ${input.sourceUrl}, current_date, true, ${input.parentId ?? null}, ${access.userId}, ${access.userId})
    returning *`;
  return tariffDto(row, installer.teamId, { analyses: 0, locked: 0 });
});

