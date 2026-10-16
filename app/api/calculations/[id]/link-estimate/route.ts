import { z } from "zod";
import { assertLeadAndEstimate, loadCalculation } from "@/lib/quote/access";
import { toLegacyPriceData } from "@/lib/quote/legacy";
import type { CalculationResult } from "@/lib/engine";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

const schema = z.object({ estimateId: uuid, quoteVersionId: uuid });

/**
 * Kobler et nytt estimat til kalkylen og en lagret versjon.
 * Flyt ved nytt estimat: lagre versjon → dashboardet oppretter estimatet med price_data → koble her.
 * Senere versjoner av kalkylen skriver da price_data direkte til estimatet.
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const { calculation } = await loadCalculation(access, id);
  const input = await body(req, schema);
  await assertLeadAndEstimate(calculation.installer_group_id, calculation.lead_id, input.estimateId);

  return sql.begin(async (tx) => {
    const [version] = await tx<{ id: string; result: CalculationResult }[]>`
      select id, result from calc.quote_versions where id = ${input.quoteVersionId} and calculation_id = ${id}`;
    if (!version) throw new HttpError(404, "Fant ikke versjonen", "NOT_FOUND");

    const [estimate] = await tx<{ signed_at: Date | null; simulation_pdf_url: string | null; battery_section: unknown }[]>`
      select signed_at, price_data->>'simulationPdfUrl' as simulation_pdf_url, price_data->'batterySection' as battery_section
      from public.estimates where id = ${input.estimateId} for update`;
    if (estimate.signed_at) throw new HttpError(409, "Estimatet er signert og kan ikke endres", "SIGNED");

    // batterySection (batterioppsettet for tilbudssiden) settes av dashboardet og er ikke en del av
    // kalkylen. Den må følge med, ellers forsvinner den når price_data skrives på nytt her.
    const priceData = {
      ...toLegacyPriceData(version.result, { quoteVersionId: version.id, simulationPdfUrl: estimate.simulation_pdf_url }),
      ...(estimate.battery_section ? { batterySection: estimate.battery_section } : {}),
    };
    await tx`
      update public.estimates
      set price_data = ${asJson(priceData)}, quote_version_id = ${version.id}, updated_at = now()
      where id = ${input.estimateId}`;
    await tx`update calc.calculations set estimate_id = ${input.estimateId} where id = ${id}`;
    return { ok: true, estimateId: input.estimateId, quoteVersionId: version.id };
  });
});
