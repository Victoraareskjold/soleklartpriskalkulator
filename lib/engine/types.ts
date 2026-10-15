/** Beløp og mengder inn: kroner/antall som desimaltekst ("1234,50") eller tall. */
export type Decimal = string | number;

/** Alle beløp ut av motoren er heltall i øre. */
export type Ore = number;

export type LineKind = "product" | "mount" | "work";
export type PriceMode = "auto" | "fixed";
export type AdjustmentMode = "auto" | "percent" | "amount";

export interface Tier {
  min: number;
  /** Inklusiv. `null` = ingen øvre grense. */
  max: number | null;
  percent: Decimal;
}

export interface LineInput {
  id: string;
  name: string;
  kind: LineKind;
  /** `"panel"` teller med i panelantallet. Øvrige verdier er bare metadata. */
  productKind?: string;
  quantity: Decimal;
  unit?: string;
  /** Enhetsgrunnlag i kroner (innkjøp/avtalt sats). */
  baseUnit: Decimal;
  markupPercent: Decimal;
  priceMode?: PriceMode;
  /** Fast salgsbeløp for hele linjen eks. mva., i kroner. Brukes når priceMode = "fixed". */
  fixedSale?: Decimal;
  /** Volumrabatt kan bare gjelde monteringslinjer. */
  reductionEligible?: boolean;
  /** Referanser og visningsdata (produkt-ID, leverandør, kategori osv.). Følger med uendret. */
  meta?: Record<string, unknown>;
}

export interface Adjustment {
  mode: AdjustmentMode;
  /** Prosent eller kroner, avhengig av mode. Ignoreres for "auto". */
  value?: Decimal;
}

export interface CalculationInput {
  currency?: "NOK";
  panelCount: number;
  lines: LineInput[];
  commission?: Adjustment;
  commissionTiers?: Tier[];
  /** Kommisjon når anlegget ikke har paneler. Standard 25 %. */
  noPanelCommissionPercent?: Decimal;
  reduction?: Adjustment;
  reductionTiers?: Tier[];
  vatPercent?: Decimal;
  /** Anslått støtte i kroner. Vises separat og påvirker ikke fakturabeløpet. */
  supportAmount?: Decimal;
}

export interface CalculatedLine
  extends Omit<LineInput, "quantity" | "baseUnit" | "markupPercent"> {
  quantity: number;
  /** Enhetsgrunnlag i øre. */
  baseUnit: Ore;
  markupPercent: number;
  /** Mengde × enhetsgrunnlag, avrundet per linje. */
  base: Ore;
  /** Linjens andel av volumrabatten. */
  reduction: Ore;
  reducedBase: Ore;
  /** Salgsbeløp hvis påslaget brukes (også når linjen har fast pris). */
  automaticSale: Ore;
  /** Faktisk salgsbeløp eks. mva. før Soleklart-kommisjon. */
  sale: Ore;
  markupAmount: Ore;
}

export interface Warning {
  code: "REDUCTION_GAP" | "FIXED_SALE";
  message: string;
  /** Blokkerende avvik hindrer lagring av tilbudsversjon. */
  blocking: boolean;
}

export interface CalculationResult {
  engineVersion: string;
  currency: "NOK";
  panelCount: number;
  lines: CalculatedLine[];
  reduction: { mode: AdjustmentMode; percent: number | null; amount: Ore; base: Ore };
  commission: { mode: AdjustmentMode; percent: number | null; amount: Ore; base: Ore };
  totals: {
    base: Ore;
    subtotal: Ore;
    markup: Ore;
    totalExVat: Ore;
    vat: Ore;
    totalIncVat: Ore;
    support: Ore;
    afterSupport: Ore;
    supplierCost: Ore;
    /** subtotal − supplierCost. Skal dekke arbeid, drift og fortjeneste. Ikke dekningsbidrag. */
    installerRemaining: Ore;
  };
  warnings: Warning[];
  /** Om prisreglene tillater lagring. Ikke en teknisk godkjenning av anlegget. */
  ready: boolean;
}
