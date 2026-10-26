import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { body, handler, preflight } from "@/lib/server/http";
import { loadAnalysis } from "@/lib/server/naering/store";
import { customerSummary, execute, prepareRun } from "@/lib/server/naering/run";

export const OPTIONS = preflight;
// Første kjøring for et nytt år henter 365 døgn spotpriser og PVGIS. Senere går det fra mellomlageret.
export const maxDuration = 60;

const schema = z.object({
  kwp: z.number().min(0).max(100_000).nullable(),
  /** Kalkylens sum eks. mva. i øre */
  investmentOre: z.number().int().min(0).nullable().optional(),
  /** true = «Hent oppdaterte kildedata», false = «Beregn med lagret grunnlag» */
  refresh: z.boolean().default(false),
});

/** Forhåndsberegning med lagrede innstillinger. Lagrer ingen kjøring (det skjer når tilbudet lagres). */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const analysis = await loadAnalysis(access, id);
  const input = await body(req, schema);
  const prepared = await prepareRun(analysis, {
    kwp: input.kwp,
    investmentNok: input.investmentOre == null ? null : input.investmentOre / 100,
    refresh: input.refresh,
  });
  const result = execute(prepared);
  return {
    summary: customerSummary(result, prepared, null),
    meta: prepared.meta,
    quality: prepared.input.consumption.level === 3 ? prepared.input.consumption.report : null,
  };
});
