import { z } from "zod";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { cleanDefinition, tariffDto, tariffInputSchema, tariffUsage, type TariffRow } from "@/lib/server/naering/tariffs";

export const OPTIONS = preflight;

async function ownTariff(req: Request, tariffId: string, installerGroupId: string | null) {
  const access = await requireAccess(req);
  const installer = await requireInstallerAccess(access, installerGroupId);
  const [t] = await sql<TariffRow[]>`select * from calc.tariffs where id = ${tariffId}`;
  if (!t || (t.team_id != null && t.team_id !== installer.teamId)) throw new HttpError(404, "Fant ikke tariffen", "NOT_FOUND");
  return { access, installer, t };
}

/**
 * Rediger en egen tariff, eller arkiver/gjenopprett (archived). Felles tariffer kan ikke endres her – lag en kopi.
 * En tariff som er brukt i et sendt tilbud kan ikke få nye satser (lag en kopi/ny versjon); sendte tilbud
 * bruker uansett sin låste kopi.
 */
export const PATCH = handler<{ tariffId: string }>(async (req, { tariffId }) => {
  const input = await body(req, tariffInputSchema.partial().extend({ installerGroupId: uuid, archived: z.boolean().optional() }));
  const { access, installer, t } = await ownTariff(req, tariffId, input.installerGroupId);
  if (t.team_id == null) throw new HttpError(403, "Felles tariffer kan ikke endres. Lag en egen kopi.", "FORBIDDEN");

  const changesRates = input.definition !== undefined || input.validFrom !== undefined || input.validTo !== undefined;
  if (changesRates) {
    const usage = await tariffUsage(tariffId);
    if (usage.locked > 0)
      throw new HttpError(409, `Tariffen er brukt i ${usage.locked} sendt(e) tilbud. Lag en kopi for å endre satsene.`, "IN_USE");
  }
  const [row] = await sql<TariffRow[]>`
    update calc.tariffs set
      grid_owner = coalesce(${input.gridOwner ?? null}, grid_owner),
      name = coalesce(${input.name ?? null}, name),
      customer_group = coalesce(${input.customerGroup ?? null}, customer_group),
      valid_from = coalesce(${input.validFrom ?? null}::date, valid_from),
      valid_to = case when ${input.validTo !== undefined} then ${input.validTo ?? null}::date else valid_to end,
      source_url = case when ${input.sourceUrl !== undefined} then ${input.sourceUrl ?? null} else source_url end,
      definition = coalesce(${input.definition ? asJson(cleanDefinition(input.definition)) : null}::jsonb, definition),
      last_checked = case when ${changesRates} then current_date else last_checked end,
      archived_at = case when ${input.archived === true} then coalesce(archived_at, now()) when ${input.archived === false} then null else archived_at end,
      updated_by = ${access.userId}
    where id = ${tariffId}
    returning *`;
  return tariffDto(row, installer.teamId, await tariffUsage(tariffId));
});

/**
 * Slett en egen tariff. Er den brukt i en analyse eller et sendt tilbud, arkiveres den i stedet:
 * den forsvinner fra listen for nye valg, men analyser og historikk beholdes.
 */
export const DELETE = handler<{ tariffId: string }>(async (req, { tariffId }) => {
  const { t } = await ownTariff(req, tariffId, new URL(req.url).searchParams.get("installerGroupId"));
  if (t.team_id == null) throw new HttpError(403, "Felles tariffer kan ikke slettes.", "FORBIDDEN");
  const usage = await tariffUsage(tariffId);
  if (usage.analyses > 0 || usage.locked > 0) {
    await sql`update calc.tariffs set archived_at = coalesce(archived_at, now()) where id = ${tariffId}`;
    return { archived: true, deleted: false, usage };
  }
  await sql`update calc.tariffs set parent_id = null where parent_id = ${tariffId}`;
  await sql`delete from calc.tariffs where id = ${tariffId}`;
  return { archived: false, deleted: true, usage };
});
