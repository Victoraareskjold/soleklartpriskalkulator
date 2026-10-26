import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { analysisDto, leadInstaller, listSeries, seriesDto, type AnalysisRow } from "@/lib/server/naering/store";
import { settingsSchema } from "@/lib/naering/settings";

export const OPTIONS = preflight;

/** Næringsanalysen for en lead (?leadId=), med serier og filer. null hvis den ikke finnes ennå. */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const leadId = uuid.parse(new URL(req.url).searchParams.get("leadId"));
  await leadInstaller(access, leadId);
  const [a] = await sql<AnalysisRow[]>`select * from calc.business_analyses where lead_id = ${leadId}`;
  if (!a) return { analysis: null, series: [], files: [] };
  const files = await sql<{ id: string; file_name: string; size_bytes: number; created_at: Date }[]>`
    select id, file_name, size_bytes, created_at from calc.business_files where analysis_id = ${a.id} order by created_at desc`;
  return {
    analysis: analysisDto(a),
    series: (await listSeries(a.id)).map(seriesDto),
    files: files.map((f) => ({ id: f.id, fileName: f.file_name, sizeBytes: f.size_bytes, createdAt: f.created_at })),
  };
});

/** Oppretter analysen for leaden (eller returnerer den som finnes). Adressen hentes fra leaden. */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, z.object({ leadId: uuid, settings: settingsSchema.optional() }));
  const { installer, lead } = await leadInstaller(access, input.leadId);
  const settings = input.settings ?? settingsSchema.parse({});
  if (!settings.location.address && lead.address) settings.location.address = lead.address;
  const [row] = await sql<AnalysisRow[]>`
    insert into calc.business_analyses (team_id, installer_group_id, lead_id, settings, created_by, updated_by)
    values (${installer.teamId}, ${installer.id}, ${input.leadId}, ${asJson(settings)}, ${access.userId}, ${access.userId})
    on conflict (lead_id) do update set lead_id = excluded.lead_id
    returning *`;
  if (!row) throw new HttpError(500, "Kunne ikke opprette analysen");
  return analysisDto(row);
});
