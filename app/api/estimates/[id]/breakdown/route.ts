import type { CalculationResult } from "@/lib/engine";
import type { BatteryOfferResult } from "@/lib/quote/battery";
import { signedBreakdown, type Selection } from "@/lib/quote/signed";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

/**
 * Intern oppstilling for «Se detaljert visning»: grunnpakken + kundens valg ved signering,
 * med innkjøp (inkl. BMS), installatørens påslag og endelig Soleklart-kommisjon.
 * Før signering vises grunnpakken alene (eller ?selection= for å se et tenkt valg).
 */
export const GET = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const [estimate] = await sql<{
    installer_group_id: string;
    signed_at: Date | null;
    signed_selection: Selection | null;
    signed_offer: unknown;
    quote_version_id: string | null;
  }[]>`
    select l.installer_group_id, e.signed_at, e.signed_selection, e.signed_offer, e.quote_version_id
    from public.estimates e join public.leads l on l.id = e.lead_id
    where e.id = ${id}`;
  if (!estimate) throw new HttpError(404, "Fant ikke estimatet", "NOT_FOUND");
  await requireInstallerAccess(access, estimate.installer_group_id).catch(() => {
    throw new HttpError(404, "Fant ikke estimatet", "NOT_FOUND");
  });
  if (!estimate.quote_version_id) {
    throw new HttpError(404, "Estimatet er laget med den gamle kalkulatoren og har ingen låst versjon", "NO_VERSION");
  }

  const [version] = await sql<{ version: number; created_at: Date; result: CalculationResult; input: { batteryOffer?: BatteryOfferResult | null } }[]>`
    select version, created_at, result, input from calc.quote_versions where id = ${estimate.quote_version_id}`;
  if (!version) throw new HttpError(404, "Fant ikke den låste versjonen", "NOT_FOUND");

  const param = new URL(req.url).searchParams.get("selection");
  const selection: Selection | null = estimate.signed_selection ?? (param ? (JSON.parse(param) as Selection) : null);

  return {
    signedAt: estimate.signed_at,
    signedOffer: estimate.signed_offer,
    version: version.version,
    versionCreatedAt: version.created_at,
    baseLines: version.result.lines.map((l) => ({
      name: l.name,
      kind: l.kind,
      quantity: l.quantity,
      purchaseOre: l.reducedBase,
      saleOre: l.sale,
      markupPercent: l.markupPercent,
    })),
    batteryOffer: version.input?.batteryOffer ?? null,
    ...signedBreakdown(version.result, version.input?.batteryOffer ?? null, selection),
  };
});
