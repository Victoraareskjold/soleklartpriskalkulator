import { z } from "zod";
import { economyFor } from "@/lib/quote/economy";
import { sql } from "@/lib/server/db";
import { handler, HttpError } from "@/lib/server/http";
import { loadSettings } from "@/lib/server/settings";

/**
 * Gjeldende forutsetninger for økonomiberegningen på et tilbud (Beregningsregler).
 * Brukes av tilbudssiden (pvwebsites, server-side) for tilbud som ikke er signert, slik at
 * endringer i Beregningsregler slår gjennom. Offentlig: inneholder bare standardverdier
 * (strømpris, nettleie, prisvekst o.l.), ingen kunde- eller prisdata.
 */
export const GET = handler(async (req) => {
  const estimateId = z.uuid().safeParse(new URL(req.url).searchParams.get("estimateId"));
  if (!estimateId.success) throw new HttpError(400, "estimateId mangler", "BAD_REQUEST");
  const [row] = await sql<{ team_id: string; private: boolean | null }[]>`
    select g.team_id, e.private
    from public.estimates e
    join public.leads l on l.id = e.lead_id
    join public.installer_groups g on g.id = l.installer_group_id
    where e.id = ${estimateId.data}`;
  if (!row) throw new HttpError(404, "Fant ikke tilbudet", "NOT_FOUND");
  // estimates.private = true betyr næring (eksisterende navngiving)
  return economyFor(await loadSettings(row.team_id), row.private ? "business" : "private");
});
