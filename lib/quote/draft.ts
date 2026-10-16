// Kalkyle-utkastet slik dashboardet sender det. Tall er tekst slik brukeren skrev dem.
import { z } from "zod";

const text = z.string().max(200);
const decimalText = z.union([z.string().max(40), z.number()]).transform(String);

// looseObject: felt UI-et legger til (f.eks. "edited") tas vare på i utkastet.
export const draftLineSchema = z.looseObject({
  id: z.string().min(1).max(100),
  kind: z.enum(["product", "mount", "work"]),
  name: text,
  detail: text.optional().default(""),
  quantity: decimalText,
  unit: z.string().max(40).default("stk"),
  baseUnit: decimalText,
  markupPercent: decimalText,
  priceMode: z.enum(["auto", "fixed"]).default("auto"),
  fixedSale: decimalText.optional().default(""),
  reductionEligible: z.boolean().default(false),
  /** Produkt-ID, taktype-ID eller arbeidstype-ID. Mangler for egendefinerte poster. */
  sourceId: z.uuid().optional(),
  /** Med i grunnlaget for solcellestøtte. Mangler = katalogens standard. */
  supportEligible: z.boolean().optional(),
});

const adjustmentSchema = z.object({
  mode: z.enum(["auto", "percent", "amount"]),
  value: decimalText.optional().default(""),
});

export const supportDraftSchema = z.object({
  /** auto = regnes etter sentrale regler (privat). off = ingen støtte. manual = eget anslag. */
  mode: z.enum(["auto", "off", "manual"]).default("auto"),
  amount: decimalText.optional().default("0"),
  provider: z.string().max(120).optional().default(""),
});

export const draftSchema = z.looseObject({
  projectName: text,
  customerType: z.enum(["private", "business"]),
  roofTypeId: z.string().max(100).optional().default(""),
  lines: z.array(draftLineSchema).max(300),
  commission: adjustmentSchema,
  reduction: adjustmentSchema,
  vatPercent: decimalText,
  /** Eldre utkast: manuelt støttebeløp */
  supportAmount: decimalText.optional().default("0"),
  support: supportDraftSchema.optional(),
  grid: z.enum(["230", "400"]).optional().default("230"),
  battery: z.boolean().optional().default(false),
});

export type Draft = z.infer<typeof draftSchema>;
export type DraftLine = z.infer<typeof draftLineSchema>;
