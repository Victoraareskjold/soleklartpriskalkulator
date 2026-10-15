import { requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { handler, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

/** Installatørene brukeren har tilgang til. */
export const GET = handler(async (req) => {
  const access = await requireAccess(req);
  const fullTeams = access.memberships.filter((m) => m.role !== "installer").map((m) => m.teamId);
  const ownGroups = access.memberships.flatMap((m) => (m.installerGroupId ? [m.installerGroupId] : []));

  const rows = await sql<{ id: string; name: string; team_id: string }[]>`
    select id, name, team_id
    from public.installer_groups
    where team_id = any(${fullTeams}::uuid[]) or id = any(${ownGroups}::uuid[])
    order by name
  `;
  return { installers: rows.map((r) => ({ id: r.id, name: r.name, teamId: r.team_id })) };
});
