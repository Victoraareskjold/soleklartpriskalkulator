import { calculate, type CalculationInput } from "@/lib/engine";
import { requireAccess } from "@/lib/server/auth";
import { handler, preflight } from "@/lib/server/http";

export const OPTIONS = preflight;

/**
 * Forhåndsvisning: regner på en ferdig bygget kalkyle.
 * Ikke autoritativ – ved lagring bygger serveren input på nytt fra databasen.
 */
export const POST = handler(async (req) => {
  await requireAccess(req);
  const input = (await req.json()) as CalculationInput;
  return calculate(input);
});
