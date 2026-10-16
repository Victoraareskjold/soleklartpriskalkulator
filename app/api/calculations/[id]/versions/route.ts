import { z } from "zod";
import { calculate } from "@/lib/engine";
import { buildEngineInput } from "@/lib/quote/build";
import { draftSchema } from "@/lib/quote/draft";
import { toLegacyPriceData } from "@/lib/quote/legacy";
import { loadCalculation } from "@/lib/quote/access";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

const schema = z.object({
  lockVersion: z.number().int().positive(),
  draft: draftSchema,
});

/**
 * Lagrer utkastet og en låst tilbudsversjon i én transaksjon.
 * Serveren bygger input fra databasen og regner på nytt; klientens summer brukes ikke.
 * Har kalkylen et estimat, skrives price_data (gammelt format) + quote_version_id dit.
 * Krever header Idempotency-Key: samme nøkkel to ganger gir samme versjon.
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const { installer } = await loadCalculation(access, id);
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, "Idempotency-Key mangler", "BAD_REQUEST");

  const [existing] = await sql<{ id: string; calculation_id: string; version: number; result: unknown }[]>`
    select id, calculation_id, version, result from calc.quote_versions where idempotency_key = ${idempotencyKey}`;
  if (existing) {
    if (existing.calculation_id !== id) throw new HttpError(409, "Idempotency-Key er brukt på en annen kalkyle", "CONFLICT");
    const [calc] = await sql<{ lock_version: number }[]>`select lock_version from calc.calculations where id = ${id}`;
    return { quoteVersionId: existing.id, version: existing.version, lockVersion: calc.lock_version, replayed: true };
  }

  const input = await body(req, schema);
  const built = await buildEngineInput(input.draft, installer);
  const result = calculate(built.input);
  if (!result.ready) {
    throw new HttpError(422, result.warnings.find((w) => w.blocking)?.message ?? "Kalkylen kan ikke lagres", "NOT_READY");
  }

  return sql.begin(async (tx) => {
    const [calc] = await tx<{ lock_version: number; estimate_id: string | null }[]>`
      select lock_version, estimate_id from calc.calculations where id = ${id} for update`;
    if (calc.lock_version !== input.lockVersion) {
      throw new HttpError(409, "Kalkylen er endret av noen andre. Last inn på nytt.", "CONFLICT");
    }

    let simulationPdfUrl: string | null = null;
    let batterySection: unknown = null;
    if (calc.estimate_id) {
      const [estimate] = await tx<{ signed_at: Date | null; simulation_pdf_url: string | null; battery_section: unknown }[]>`
        select signed_at, price_data->>'simulationPdfUrl' as simulation_pdf_url, price_data->'batterySection' as battery_section
        from public.estimates where id = ${calc.estimate_id} for update`;
      if (estimate?.signed_at) throw new HttpError(409, "Estimatet er signert og kan ikke endres", "SIGNED");
      simulationPdfUrl = estimate?.simulation_pdf_url ?? null;
      batterySection = estimate?.battery_section ?? null;
    }

    const [previous] = await tx<{ id: string; version: number }[]>`
      select id, version from calc.quote_versions where calculation_id = ${id} order by version desc limit 1`;
    const version = (previous?.version ?? 0) + 1;

    const [saved] = await tx<{ id: string }[]>`
      insert into calc.quote_versions (
        calculation_id, version, parent_version_id, estimate_id, engine_version, input, result,
        total_ex_vat_ore, total_inc_vat_ore, idempotency_key, created_by)
      values (
        ${id}, ${version}, ${previous?.id ?? null}, ${calc.estimate_id}, ${result.engineVersion},
        ${asJson({ ...built.input, rules: built.rules })}, ${asJson(result)},
        ${result.totals.totalExVat}, ${result.totals.totalIncVat}, ${idempotencyKey}, ${access.userId})
      returning id`;

    const [updated] = await tx<{ lock_version: number }[]>`
      update calc.calculations
      set draft_input = ${asJson(input.draft)}, title = ${input.draft.projectName || "Kalkyle"},
          customer_type = ${input.draft.customerType}, lock_version = lock_version + 1, updated_by = ${access.userId}
      where id = ${id}
      returning lock_version`;

    // batterySection hører til tilbudssiden (settes av dashboardet), ikke til kalkylen: behold den.
    const priceData = {
      ...toLegacyPriceData(result, { quoteVersionId: saved.id, simulationPdfUrl }),
      ...(batterySection ? { batterySection } : {}),
    };
    if (calc.estimate_id) {
      await tx`
        update public.estimates
        set price_data = ${asJson(priceData)}, quote_version_id = ${saved.id}, updated_at = now()
        where id = ${calc.estimate_id}`;
    }

    return {
      quoteVersionId: saved.id,
      version,
      lockVersion: updated.lock_version,
      estimateId: calc.estimate_id,
      totals: result.totals,
      priceData,
    };
  });
});
