import "server-only";
import { requireInstallerAccess, type Access } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";

export interface CalculationRow {
  id: string;
  team_id: string;
  installer_group_id: string;
  lead_id: string | null;
  estimate_id: string | null;
  title: string;
  customer_type: "private" | "business";
  draft_input: unknown;
  lock_version: number;
  created_at: Date;
  updated_at: Date;
}

/** Henter kalkylen og sjekker at brukeren har tilgang til installatøren den tilhører. */
export async function loadCalculation(access: Access, id: string) {
  const [row] = await sql<CalculationRow[]>`select * from calc.calculations where id = ${id}`;
  if (!row) throw new HttpError(404, "Fant ikke kalkylen", "NOT_FOUND");
  const installer = await requireInstallerAccess(access, row.installer_group_id).catch(() => {
    throw new HttpError(404, "Fant ikke kalkylen", "NOT_FOUND");
  });
  return { calculation: row, installer };
}

/** Lead og estimat må høre til samme installatør som kalkylen. */
export async function assertLeadAndEstimate(installerGroupId: string, leadId: string | null, estimateId: string | null) {
  if (leadId) {
    const [lead] = await sql`select 1 from public.leads where id = ${leadId} and installer_group_id = ${installerGroupId}`;
    if (!lead) throw new HttpError(404, "Fant ikke leaden for denne installatøren", "NOT_FOUND");
  }
  if (estimateId) {
    const [estimate] = await sql<{ lead_id: string }[]>`
      select e.lead_id from public.estimates e join public.leads l on l.id = e.lead_id
      where e.id = ${estimateId} and l.installer_group_id = ${installerGroupId}`;
    if (!estimate) throw new HttpError(404, "Fant ikke estimatet for denne installatøren", "NOT_FOUND");
    if (leadId && estimate.lead_id !== leadId) throw new HttpError(400, "Estimatet hører til en annen lead", "BAD_REQUEST");
  }
}

export const toCalculationDto = (c: CalculationRow) => ({
  id: c.id,
  installerGroupId: c.installer_group_id,
  leadId: c.lead_id,
  estimateId: c.estimate_id,
  title: c.title,
  customerType: c.customer_type,
  draft: c.draft_input,
  lockVersion: c.lock_version,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});
