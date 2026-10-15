import "server-only";
import { z } from "zod";
import { toOre, CalculationError } from "@/lib/engine";

/** Kroner inn som tall eller desimaltekst ("1234,50"). Gir øre ut. */
export const kroner = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    const ore = toOre(value);
    if (ore < 0) throw new CalculationError("negativ");
    return ore;
  } catch {
    ctx.addIssue({ code: "custom", message: "Ugyldig beløp" });
    return z.NEVER;
  }
});

export const percent = (max = 100) =>
  z.coerce.number({ message: "Ugyldig prosent" }).min(0, "Kan ikke være negativ").max(max, `Maks ${max} %`);

export const uuid = z.uuid({ message: "Ugyldig ID" });

export const markupGroup = z.enum(["solcellemateriell", "frakt", "stillase", "ballastein", "elektro", "montering"]);

export const workGroup = z.enum(["søknad", "solcelleanlegg", "batteri", "tillegg"]);

export const tiers = z.array(
  z.object({
    min: z.number().int().min(0),
    max: z.number().int().min(0).nullable(),
    percent: percent(),
  }),
);
