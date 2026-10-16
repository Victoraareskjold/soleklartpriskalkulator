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

/** Påslagsgruppe-kode, f.eks. "solcellemateriell" eller "dc-ladere". Finnes i calc.markup_groups. */
export const markupGroup = z.string().trim().min(1).max(40).regex(/^[a-z0-9æøå_-]+$/, "Ugyldig kode");

export const productKind = z.enum(["panel", "feste", "inverter", "batteri", "frakt", "stillase", "ballastein", "annet"]);

/** Tekniske produktdata som brukes i beregningene. Ukjente felt beholdes. */
export const specs = z.looseObject({
  wp: z.number().positive().max(2000).optional(),
  acKw: z.number().positive().max(10000).optional(),
  maxPvKwp: z.number().positive().max(20000).optional(),
  grid: z.enum(["230", "400", "begge"]).optional(),
  phases: z.union([z.literal(1), z.literal(3)]).optional(),
  hybrid: z.boolean().optional(),
  batteryClass: z.enum(["HV", "LV"]).optional(),
  capacityKwh: z.number().positive().max(100000).optional(),
  powerKw: z.number().positive().max(100000).optional(),
  derived: z.boolean().optional(),
});

export const workGroup = z.enum(["søknad", "solcelleanlegg", "batteri", "tillegg"]);

export const tiers = z.array(
  z.object({
    min: z.number().int().min(0),
    max: z.number().int().min(0).nullable(),
    percent: percent(),
  }),
);

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Navn mangler").max(120),
  /** Hovedkategori hvis dette er en underkategori. Underkategorien arver regler fra hovedkategorien. */
  parentId: uuid.nullable().optional(),
  productKind: productKind.default("annet"),
  markupGroup: markupGroup,
  quantityRule: z.enum(["manual", "per_panel"]).default("manual"),
  supportEligible: z.boolean().default(false),
});

/** Endring av kategori: ingen standardverdier, så bare feltene som sendes endres. */
export const categoryPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    productKind,
    markupGroup,
    quantityRule: z.enum(["manual", "per_panel"]),
    supportEligible: z.boolean(),
  })
  .partial();
