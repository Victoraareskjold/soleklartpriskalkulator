import type { CalculationResult } from "@/lib/engine";
import { loadCalculation } from "@/lib/quote/access";
import { toLegacyPriceData } from "@/lib/quote/legacy";
import { requireAccess } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { handler, HttpError, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

/** En låst versjon med input, resultat og price_data slik den ble skrevet. Intern visning. */
export const GET = handler<{ id: string }>(async (req, { id }) => {
  const access = await requireAccess(req);
  const [row] = await sql<{ id: string; calculation_id: string; version: number; input: unknown; result: CalculationResult; created_at: Date; estimate_id: string | null }[]>`
    select id, calculation_id, version, input, result, created_at, estimate_id from calc.quote_versions where id = ${id}`;
  if (!row) throw new HttpError(404, "Fant ikke versjonen", "NOT_FOUND");
  await loadCalculation(access, row.calculation_id);
  return {
    id: row.id,
    calculationId: row.calculation_id,
    version: row.version,
    estimateId: row.estimate_id,
    createdAt: row.created_at,
    input: row.input,
    result: row.result,
    priceData: toLegacyPriceData(row.result, { quoteVersionId: row.id }),
  };
});
