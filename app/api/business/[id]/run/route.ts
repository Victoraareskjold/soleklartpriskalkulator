import { z } from "zod";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { body, handler, preflight } from "@/lib/server/http";
import { loadAnalysis } from "@/lib/server/naering/store";
import { customerSummary, execute, prepareRun, quoteContext } from "@/lib/server/naering/run";
import { draftSchema } from "@/lib/quote/draft";
import { evaluateDraft } from "@/lib/quote/evaluate";

export const OPTIONS = preflight;
// Første kjøring for et nytt år henter 365 døgn spotpriser og PVGIS. Senere går det fra mellomlageret.
export const maxDuration = 60;

const schema = z.object({
  /** Tilbudets utkast. Regnes på serveren (kWp, investering, inverter) – samme vei som ved lagring. */
  draft: draftSchema,
  /** true = «Oppdater kildedata» (spotpriser og PVGIS hentes på nytt), false = bruk lagret grunnlag */
  refresh: z.boolean().default(false),
});

/** Beregner analysen med lagrede innstillinger og tilbudet slik det står nå. Lagrer ingen kjøring. */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const analysis = await loadAnalysis(access, id);
  const input = await body(req, schema);
  const installer = await requireInstallerAccess(access, analysis.installer_group_id);
  const evaluated = await evaluateDraft(input.draft, installer);
  const quote = quoteContext(evaluated.built, evaluated.result, evaluated.built.rules.settings, input.draft);
  const prepared = await prepareRun(analysis, { quote, refresh: input.refresh });
  const result = execute(prepared);
  return {
    summary: customerSummary(result, prepared, null),
    quote,
    meta: { pvgis: prepared.meta.pvgis, spot: prepared.meta.spot, tariff: { id: prepared.meta.tariff.id, name: prepared.meta.tariff.name } },
    quality: prepared.input.consumption.level === 3 ? prepared.input.consumption.report : null,
  };
});
