import { z } from "zod";
import { evaluateDraft } from "@/lib/quote/evaluate";
import { draftSchema } from "@/lib/quote/draft";
import { requireAccess, requireInstallerAccess } from "@/lib/server/auth";
import { body, handler, preflight } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

export const OPTIONS = preflight;

/**
 * Forhåndsvisning av et utkast med nøyaktig samme regler som ved lagring
 * (katalogdata, kWp, støtte og trinn hentes fra databasen). Lagrer ingenting.
 */
export const POST = handler(async (req) => {
  const access = await requireAccess(req);
  const input = await body(req, z.object({ installerGroupId: uuid, draft: draftSchema }));
  const installer = await requireInstallerAccess(access, input.installerGroupId);
  const e = await evaluateDraft(input.draft, installer);
  return { kwp: e.built.kwp, result: e.result, batteryOffer: e.batteryOffer, economy: e.economy };
});
