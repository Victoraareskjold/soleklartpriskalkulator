import { z } from "zod";
import { draftSchema } from "@/lib/quote/draft";
import { evaluateDraft, priceDataFor, versionInput } from "@/lib/quote/evaluate";
import { loadCalculation } from "@/lib/quote/access";
import { requireAccess } from "@/lib/server/auth";
import { asJson, sql } from "@/lib/server/db";
import { body, handler, HttpError, preflight } from "@/lib/server/http";
import { loadAnalysis } from "@/lib/server/naering/store";
import { execute, investmentFromDraft, lockRun, notCalculated, prepareRun, type PreparedRun } from "@/lib/server/naering/run";
import type { AnalysisResult } from "@/lib/naering/analysis";

export const OPTIONS = preflight;
// Næring: analysen regnes før låsing (henter spotpriser/PVGIS hvis de ikke er mellomlagret)
export const maxDuration = 60;

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
  const evaluated = await evaluateDraft(input.draft, installer);
  const { result } = evaluated;
  if (!result.ready) {
    throw new HttpError(422, result.warnings.find((w) => w.blocking)?.message ?? "Kalkylen kan ikke lagres", "NOT_READY");
  }

  // Næring: analysen regnes (med lagret grunnlag) før transaksjonen, og låses sammen med versjonen.
  // Mangler det opplysninger, lagres tilbudet likevel med «ikke beregnet» og årsaken – aldri en stille nullverdi.
  let business: { analysisId: string; prepared: PreparedRun; result: AnalysisResult } | { error: string } | null = null;
  const businessAnalysisId = input.draft.customerType === "business" ? input.draft.businessAnalysisId : undefined;
  if (businessAnalysisId) {
    const analysis = await loadAnalysis(access, businessAnalysisId);
    const [calcLead] = await sql<{ lead_id: string | null }[]>`select lead_id from calc.calculations where id = ${id}`;
    if (calcLead?.lead_id && calcLead.lead_id !== analysis.lead_id) throw new HttpError(400, "Næringsanalysen hører til en annen lead", "BAD_REQUEST");
    try {
      const inv = investmentFromDraft({ battery: input.draft.battery, lines: evaluated.built.input.lines }, result.totals.totalExVat);
      const prepared = await prepareRun(analysis, { kwp: evaluated.built.kwp, investmentNok: inv.nok, investmentNote: inv.note });
      business = { analysisId: analysis.id, prepared, result: execute(prepared) };
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500 && e.status !== 502) throw e;
      business = { error: e.message };
    }
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
        ${asJson(versionInput(evaluated))}, ${asJson(result)},
        ${result.totals.totalExVat}, ${result.totals.totalIncVat}, ${idempotencyKey}, ${access.userId})
      returning id`;

    const [updated] = await tx<{ lock_version: number }[]>`
      update calc.calculations
      set draft_input = ${asJson(input.draft)}, title = ${input.draft.projectName || "Kalkyle"},
          customer_type = ${input.draft.customerType}, lock_version = lock_version + 1, updated_by = ${access.userId}
      where id = ${id}
      returning lock_version`;

    // Batteritillegget regnes nå i kalkylen. Eldre utkast uten batteroppsett beholder estimatets batterySection.
    const businessAnalysis = !business
      ? undefined
      : "error" in business
        ? notCalculated(business.error)
        : await lockRun(tx, business.analysisId, saved.id, calc.estimate_id, business.prepared, business.result, access.userId);
    const priceData = {
      ...priceDataFor(result, versionInput(evaluated), {
        quoteVersionId: saved.id,
        simulationPdfUrl,
        keepBatterySection: batterySection,
      }),
      ...(businessAnalysis ? { businessAnalysis } : {}),
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
      batteryOffer: evaluated.batteryOffer,
    };
  });
});
