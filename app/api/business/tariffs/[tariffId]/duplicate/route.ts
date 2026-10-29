import { z } from "zod";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { tariffDto, type TariffRow } from "@/lib/server/naering/tariffs";

export const OPTIONS = preflight;

/** «Lag egen kopi»: kopierer en felles eller egen tariff til teamet, så den kan endres uten å påvirke andre tilbud. */
export const POST = handler<{ tariffId: string }>(async (req, { tariffId }) => {
  const access = await requireAccess(req);
  const input = await body(req, z.object({ installerGroupId: uuid, name: z.string().trim().min(1).max(160).optional() }));
  const installer = await requireInstallerAccess(access, input.installerGroupId);
  const [t] = await sql<TariffRow[]>`select * from calc.tariffs where id = ${tariffId}`;
  if (!t || (t.team_id != null && t.team_id !== installer.teamId)) throw new HttpError(404, "Fant ikke tariffen", "NOT_FOUND");
  const [row] = await sql<TariffRow[]>`
    insert into calc.tariffs (team_id, grid_owner, name, customer_group, valid_from, valid_to, definition, source_url, last_checked, is_manual, parent_id, created_by, updated_by)
    values (${installer.teamId}, ${t.grid_owner}, ${input.name ?? `${t.name} (kopi)`}, ${t.customer_group}, ${t.valid_from}, ${t.valid_to},
            ${sql.json(t.definition as never)}, ${t.source_url}, ${t.last_checked}, true, ${t.id}, ${access.userId}, ${access.userId})
    returning *`;
  return tariffDto(row, installer.teamId, { analyses: 0, locked: 0 });
});
