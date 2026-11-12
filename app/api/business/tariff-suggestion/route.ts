import { z } from "zod";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { body, handler, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { geocode, gridAreaAt } from "@/lib/server/naering/sources";
import { isGridDef, suggestTariff, type GridTariffDefinition } from "@/lib/naering/gridtariff";
import { companyName } from "@/lib/naering/gridarea";

export const OPTIONS = preflight;

const schema = z.object({
  installerGroupId: uuid,
  address: z.string().max(300).nullable().default(null),
  lat: z.number().min(57).max(72).nullable().default(null),
  lon: z.number().min(4).max(32).nullable().default(null),
  annualKwh: z.number().min(0).max(1e9).nullable().default(null),
  level: z.enum(["lavspent", "hoeyspent"]).nullable().default(null),
  mainFuseA: z.number().min(0).max(10_000).nullable().default(null),
  voltageV: z.union([z.literal(230), z.literal(400)]).nullable().default(null),
  /** Velg nettselskap selv (overstyrer oppslaget), f.eks. «GL» */
  companyCode: z.string().max(4).nullable().default(null),
  area: z.string().max(80).nullable().default(null),
  /** Datoen prisversjonen kontrolleres for (standard: i dag) */
  date: z.iso.date().nullable().default(null),
  refresh: z.boolean().default(false),
});

/**
 * Forslag til nettariff for et målepunkt: nettselskap fra adressen (NVE, ellers kommunen), deretter produkt
 * ut fra årsforbruk, spenningsnivå og hovedsikring. Bare ordinære, entydige treff foreslås.
 * Avtaler og tariffer som må avklares vises som alternativer, men velges aldri automatisk.
 */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, schema);
  await requireInstallerAccess(access, input.installerGroupId);

  let { lat, lon } = input;
  let municipality: string | null = null;
  let address = input.address;
  if (input.address && (lat == null || lon == null || !input.companyCode)) {
    const g = await geocode(input.address);
    lat ??= g.lat;
    lon ??= g.lon;
    municipality = g.municipality;
    address = g.address;
  }
  const area =
    input.companyCode != null
      ? {
          companies: [{ code: input.companyCode, name: companyName(input.companyCode), area: input.area }],
          rawNames: [],
          source: "valgt" as const,
          note: "Nettselskapet er valgt av selger.",
        }
      : lat != null && lon != null
        ? await gridAreaAt(lat, lon, municipality, input.refresh)
        : { companies: [], rawNames: [], source: "ingen" as const, note: "Mangler adresse for å finne nettselskapet." };

  const rows = await sql<{ id: string; definition: unknown }[]>`
    select id, definition from calc.tariffs where team_id is null and archived_at is null and definition->>'format' = 'nettariff-v1'`;
  const defs = rows.filter((r) => isGridDef(r.definition)).map((r) => ({ id: r.id, def: r.definition as GridTariffDefinition }));
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  const candidates = area.companies.flatMap((c) =>
    suggestTariff(
      defs.map((d) => ({ def: d.def, date })),
      { companyCode: c.code, area: c.area ?? null, annualKwh: input.annualKwh, level: input.level, mainFuseA: input.mainFuseA, voltageV: input.voltageV },
    ).map((x) => ({
      ...x,
      company: c.name,
      tariffId: defs.find((d) => d.def.product.id === x.productId && d.def.area === x.area)?.id ?? null,
      areaNote: (c as { areaNote?: string }).areaNote ?? null,
    })),
  );
  // Foreslå bare når det er ett entydig, ordinært treff hos ett nettselskap
  const sure = candidates.filter((c) => c.fit === "foreslått");
  const suggested = area.companies.length === 1 && sure.length === 1 ? sure[0] : null;
  return {
    address,
    municipality,
    gridArea: area,
    candidates,
    suggested: suggested ? { tariffId: suggested.tariffId, name: suggested.name, reason: [suggested.company, ...suggested.reasons].join(" · ") } : null,
  };
});
