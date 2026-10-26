import { z } from "zod";
import { requireAccess } from "@/lib/server/auth";
import { body, handler, preflight } from "@/lib/server/http";
import { geocode } from "@/lib/server/naering/sources";

export const OPTIONS = preflight;

/** Adresse → koordinater og foreslått prisområde (Kartverket). Forslaget må kontrolleres. */
export const POST = handler(async (req) => {
  await requireAccess(req);
  const input = await body(req, z.object({ address: z.string().min(3).max(300) }));
  return geocode(input.address);
});
