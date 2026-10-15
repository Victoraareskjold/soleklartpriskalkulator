// Kalkyle-utkastet slik dashboardet sender det. Tall er tekst slik brukeren skrev dem.
import { z } from "zod";

const text = z.string().max(200);
const decimalText = z.union([z.string().max(40), z.number()]).transform(String);

export const draftLineSchema = z.object({
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
});

const adjustmentSchema = z.object({
  mode: z.enum(["auto", "percent", "amount"]),
  value: decimalText.optional().default(""),
});

export const draftSchema = z.object({
  projectName: text,
  customerType: z.enum(["private", "business"]),
  roofTypeId: z.string().max(100).optional().default(""),
  lines: z.array(draftLineSchema).max(300),
  commission: adjustmentSchema,
  reduction: adjustmentSchema,
  vatPercent: decimalText,
  supportAmount: decimalText,
});

export type Draft = z.infer<typeof draftSchema>;
export type DraftLine = z.infer<typeof draftLineSchema>;
