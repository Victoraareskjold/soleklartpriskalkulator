import { z } from "zod";
import { adminTeamId, requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { MAP_PANEL_STEPS, toMapPanel, type MapPanelRow } from "@/lib/server/mapPanels";

export const OPTIONS = preflight;

const price = z.coerce.number().min(0).max(1_000_000);
const schema = z
  .object({
    name: z.string().trim().min(1, "Navn mangler").max(120),
    watt: z.coerce.number().int().min(100, "Effekt i watt virker for lav").max(1500),
    description: z.string().trim().max(500).nullable(),
    prices: z.object(Object.fromEntries(MAP_PANEL_STEPS.map((s) => [s, price])) as Record<(typeof MAP_PANEL_STEPS)[number], typeof price>).partial(),
  })
  .partial();

/** Endre navn/tekst, effekt og omtrentlig pris for et panelvalg i solkartet. Bare admin. */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  adminTeamId(access);
  const input = await body(req, schema);

  const columns: Record<string, unknown> = {};
  if (input.name !== undefined) columns.NAVN = input.name;
  if (input.watt !== undefined) columns.WATTAGE = input.watt;
  if (input.description !== undefined) columns.description = input.description || null;
  for (const [step, value] of Object.entries(input.prices ?? {})) if (value !== undefined) columns[step] = value;
  if (!Object.keys(columns).length) throw new HttpError(400, "Ingen endringer", "BAD_REQUEST");

  const [row] = await sql<MapPanelRow[]>`
    update public.solarpanels set ${sql(columns)} where id = ${id}
    returning id, "NAVN", "WATTAGE", description, ${sql(MAP_PANEL_STEPS as unknown as string[])}`;
  if (!row) throw new HttpError(404, "Fant ikke panelvalget", "NOT_FOUND");
  return toMapPanel(row);
});
