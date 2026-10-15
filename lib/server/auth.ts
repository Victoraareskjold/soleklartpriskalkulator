import "server-only";
import { sql } from "./db";
import { HttpError } from "./http";

export type TeamRole = "admin" | "member" | "installer";

export interface Membership {
  teamId: string;
  role: TeamRole;
  installerGroupId: string | null;
}

export interface Access {
  userId: string;
  memberships: Membership[];
}

/**
 * Verifiserer Supabase-tokenet fra dashboardet og henter brukerens medlemskap.
 * Team og installatør kommer alltid fra databasen, aldri fra klienten.
 */
export async function requireAccess(req: Request): Promise<Access> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Mangler innlogging", "UNAUTHENTICATED");

  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new HttpError(500, "SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY mangler", "CONFIG");
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => {
    throw new HttpError(503, "Fikk ikke kontakt med Supabase Auth", "AUTH_UNAVAILABLE");
  });
  if (!res.ok) throw new HttpError(401, "Ugyldig eller utløpt innlogging", "UNAUTHENTICATED");
  const user = (await res.json()) as { id: string };

  const rows = await sql<{ team_id: string; role: TeamRole; installer_group_id: string | null }[]>`
    select team_id, role, installer_group_id
    from public.team_members
    where user_id = ${user.id}
  `;
  if (!rows.length) throw new HttpError(403, "Brukeren er ikke med i noe team", "FORBIDDEN");

  return {
    userId: user.id,
    memberships: rows.map((row) => ({
      teamId: row.team_id,
      role: row.role,
      installerGroupId: row.installer_group_id,
    })),
  };
}

/** Admin og medlem ser alle installatører i teamet. Installatør ser bare sin egen. */
export async function requireInstallerAccess(access: Access, installerGroupId: string | null) {
  if (!installerGroupId) throw new HttpError(400, "installerGroupId mangler", "BAD_REQUEST");

  const [group] = await sql<{ id: string; team_id: string; name: string }[]>`
    select id, team_id, name from public.installer_groups where id = ${installerGroupId}
  `;
  const allowed =
    group &&
    access.memberships.some(
      (m) =>
        m.teamId === group.team_id &&
        (m.role === "admin" || m.role === "member" || m.installerGroupId === group.id),
    );
  // Samme svar for "finnes ikke" og "ingen tilgang", så ID-er ikke kan gjettes.
  if (!allowed) throw new HttpError(404, "Fant ikke installatøren", "NOT_FOUND");
  return { id: group.id, teamId: group.team_id, name: group.name };
}

export function isAdmin(access: Access, teamId: string) {
  return access.memberships.some((m) => m.teamId === teamId && m.role === "admin");
}

/** Kun team-admin kan endre katalog, satser og innstillinger. */
export function requireAdmin(access: Access, teamId: string) {
  if (!isAdmin(access, teamId)) throw new HttpError(403, "Bare admin kan endre priser", "FORBIDDEN");
}

/** Teamet brukeren er admin i (prisoppsett er per team). */
export function adminTeamId(access: Access): string {
  const membership = access.memberships.find((m) => m.role === "admin");
  if (!membership) throw new HttpError(403, "Bare admin kan endre priser", "FORBIDDEN");
  return membership.teamId;
}

/** Tilgang til installatøren + admin i teamet. */
export async function requireInstallerAdmin(access: Access, installerGroupId: string) {
  const installer = await requireInstallerAccess(access, installerGroupId);
  requireAdmin(access, installer.teamId);
  return installer;
}
