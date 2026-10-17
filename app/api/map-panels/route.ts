import { requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { handler, preflight } from "@/lib/server/http";
import { MAP_PANEL_STEPS, toMapPanel, type MapPanelRow } from "@/lib/server/mapPanels";

export const OPTIONS = preflight;

/**
 * Panelalternativene i solkartet (pvmap leser public.solarpanels direkte).
 * Felles for alle nettsidene. Alle innloggede kan lese; bare admin kan endre.
 */
export const GET = handler(async (req) => {
  await requireAccess(req);
  const rows = await sql<MapPanelRow[]>`
    select id, "NAVN", "WATTAGE", description, ${sql(MAP_PANEL_STEPS as unknown as string[])}
    from public.solarpanels order by "NAVN"`;
  return { panels: rows.map(toMapPanel) };
});
