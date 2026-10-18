// Oversetter et beregningsresultat til dagens `estimates.price_data`-format (PriceOverview i
// soleklartdashboard/types/price_table.ts). Brukes i overgangen så estimatsiden, kjøpsavtalen
// og pvwebsites virker uendret. Beløp i kroner, eks. mva., inkl. påslag.
import type { CalculationResult } from "@/lib/engine";
import type { LineMeta } from "./build";

export interface LegacyLineItem {
  id: string;
  name: string;
  supplier: string;
  product: string;
  category: string;
  quantity: number;
  priceWithMarkup: number;
  capacityKwh?: number | null;
  attachmentUrl?: string;
}

export interface LegacyPriceData {
  suppliers: LegacyLineItem[];
  mounting: LegacyLineItem[];
  installation: {
    søknad: { priceWithMarkup: number };
    solcelleAnlegg: { priceWithMarkup: number };
    battery: { selectedBatteryId: string | null; priceWithMarkup: number };
    additionalCosts: { id: string; name: string; quantity: number; priceWithMarkup: number }[];
  };
  simulationPdfUrl?: string | null;
  total: number;
  "total inkl. alt": number;
  totalOverride: null;
  /** Ny kalkulator: peker til den låste versjonen. Ignoreres av gamle lesere. */
  quoteVersionId?: string;
  /** Ny kalkulator: anslått støtte (vises separat, inngår ikke i total). Ignoreres av gamle lesere. */
  estimatedSupport?: { provider: string | null; amount: number; mode: string } | null;
}

const kr = (ore: number) => ore / 100;

export function toLegacyPriceData(
  result: CalculationResult,
  options: { quoteVersionId?: string; simulationPdfUrl?: string | null } = {},
): LegacyPriceData {
  const lines = result.lines.map((line) => ({ line, meta: (line.meta ?? {}) as Partial<LineMeta> }));
  const item = ({ line, meta }: (typeof lines)[number], fallbackCategory: string): LegacyLineItem => ({
    id: line.id,
    name: line.name,
    supplier: meta.supplier ?? "",
    // Teksten på linjen (kan være endret i tilbudet); montering vises som taktype
    product: line.kind === "mount" ? (meta.roofTypeName ?? line.name) : line.name,
    category: meta.category ?? fallbackCategory,
    quantity: line.quantity,
    priceWithMarkup: kr(line.sale),
    ...(meta.capacityKwh != null ? { capacityKwh: meta.capacityKwh } : {}),
    ...(meta.attachmentUrl ? { attachmentUrl: meta.attachmentUrl } : {}),
  });

  const works = lines.filter(({ line }) => line.kind === "work");
  const sumGroup = (group: string) => kr(works.filter(({ meta }) => meta.workGroup === group).reduce((s, { line }) => s + line.sale, 0));
  const battery = works.find(({ meta }) => meta.workGroup === "batteri");

  return {
    suppliers: lines.filter(({ line }) => line.kind === "product").map((l) => item(l, "annet")),
    mounting: lines.filter(({ line }) => line.kind === "mount").map((l) => item(l, "montering")),
    installation: {
      søknad: { priceWithMarkup: sumGroup("søknad") },
      solcelleAnlegg: { priceWithMarkup: sumGroup("solcelleanlegg") },
      battery: { selectedBatteryId: battery?.meta.sourceId ?? null, priceWithMarkup: sumGroup("batteri") },
      // Tillegg og egendefinert arbeid
      additionalCosts: works
        .filter(({ meta }) => !meta.workGroup || meta.workGroup === "tillegg")
        .map(({ line }) => ({ id: line.id, name: line.name, quantity: line.quantity, priceWithMarkup: kr(line.sale) })),
    },
    simulationPdfUrl: options.simulationPdfUrl ?? null,
    total: kr(result.totals.totalExVat),
    "total inkl. alt": kr(result.totals.totalIncVat),
    totalOverride: null,
    estimatedSupport: result.support && result.support.amount > 0
      ? { provider: result.support.provider, amount: kr(result.support.amount), mode: result.support.mode }
      : null,
    ...(options.quoteVersionId ? { quoteVersionId: options.quoteVersionId } : {}),
  };
}
