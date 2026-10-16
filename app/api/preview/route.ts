import { z } from "zod";
import { calculate } from "@/lib/engine";
import { buildEngineInput } from "@/lib/quote/build";
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
  const built = await buildEngineInput(input.draft, installer);
  return { kwp: built.kwp, result: calculate(built.input) };
});
