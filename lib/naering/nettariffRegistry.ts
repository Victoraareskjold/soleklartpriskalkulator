// Tariffpakken (nettariffer.json fra Asbjørn) → én tariffdefinisjon per produkt og nettområde.
// Brukes av importen til databasen (scripts/nettariffer-sql.ts) og av testene.

import type { GridTariffDefinition, NtFeedIn, NtProduct, NtVersion } from "./gridtariff";
import { AREA_LABELS } from "./gridtariff";
import type { Tariff } from "./tariff";

export interface TariffPackage {
  versjon: string;
  sjekket_dato: string;
  dekningsaar_for_uttak: number[];
  avgifter_2026?: { enova_naering_kr_per_aar_per_maalepunkt?: number };
  nettselskaper: Record<string, string>;
  produkter: NtProduct[];
  uttaksversjoner: NtVersion[];
  innmating_egen_vurdering: NtFeedIn[];
  kilder: Record<string, { tittel: string; url: string; kontrollert?: string }>;
}

/** Stabil kode i registeret: produkt + område, f.eks. «GL.L:tidligere_norgesnett_fredrikstad_mfl». */
export const tariffCode = (productId: string, area: string) => `${productId}:${area}`;

export function gridDefinitions(pkg: TariffPackage): GridTariffDefinition[] {
  const year = Math.max(...pkg.dekningsaar_for_uttak);
  const out: GridTariffDefinition[] = [];
  for (const product of pkg.produkter) {
    const versions = pkg.uttaksversjoner.filter((v) => v.produkt === product.id);
    const areas = [...new Set(versions.map((v) => v.omraadeversjon))];
    for (const area of areas) {
      const vs = versions.filter((v) => v.omraadeversjon === area).sort((a, b) => a.dekket_fra.localeCompare(b.dekket_fra));
      const used = new Set(vs.flatMap((v) => v.kilder));
      out.push({
        format: "nettariff-v1",
        dataVersion: pkg.versjon,
        checked: pkg.sjekket_dato,
        coveredUntil: `${year + 1}-01-01`,
        coveredYear: year,
        product,
        area,
        areaLabel: AREA_LABELS[area] ?? area.replaceAll("_", " "),
        versions: vs,
        sources: Object.fromEntries(Object.entries(pkg.kilder).filter(([k]) => used.has(k))),
        feedIn: pkg.innmating_egen_vurdering.filter((f) => f.nettselskap === product.nettselskap),
        enovaNokPerYear: pkg.avgifter_2026?.enova_naering_kr_per_aar_per_maalepunkt ?? 800,
      });
    }
  }
  return out;
}

/** Visningsnavn i menyen: «Glitre Nett · Større bedrift – lavspent», med område når produktet finnes i flere. */
export const gridTariffName = (d: GridTariffDefinition) => (d.areaLabel ? `${d.product.navn_i_valg} (${d.areaLabel})` : d.product.navn_i_valg);

/** En Tariff klar for motoren (testene og forslaget; databasen lager den samme i run.ts). */
export function gridTariff(d: GridTariffDefinition, extra: Partial<Pick<Tariff, "contractedKw" | "feedIn">> = {}): Tariff {
  const from = d.versions[0]?.dekket_fra ?? `${d.coveredYear}-01-01`;
  return {
    id: tariffCode(d.product.id, d.area),
    gridOwner: d.product.nettselskap,
    name: gridTariffName(d),
    customerGroup: d.product.vilkaar,
    validFrom: from,
    validTo: `${d.coveredYear}-12-31`,
    fixedNokPerYear: 0,
    fixedAllocation: "per_måned",
    energyOrePerKwh: 0,
    vat: "eks_mva",
    provenance: { status: "antatt", sourceType: "tariffregister", source: `Tariffregister ${d.dataVersion}`, lastChecked: d.checked },
    notes: [],
    grid: d,
    ...extra,
  };
}
