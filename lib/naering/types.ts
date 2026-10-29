// Felles typer for næringsanalysen (trinn 1).
// Prinsipp: alle tidsserier lagres på en UTC-akse med faste intervaller,
// verdien er ENERGI (kWh) i intervallet, og hver serie bærer med seg kilde og status.

/** Hvordan en verdi er fremkommet. Vises til selger og kunde. */
export type DataStatus = "målt" | "beregnet" | "antatt";

/**
 * Hva slags kilde en verdi har. Mer presist enn status: offentlige spotpriser er «markedspriser»,
 * ikke måledata, og en tariff i registeret er ikke automatisk bekreftet for kundens målepunkt.
 */
export type SourceType = "måledata" | "markedspriser" | "tariffregister" | "simulert" | "oppgitt" | "antatt" | "beregnet";

/** Avvik som vises ved feltet og i oppsummeringen over resultatet. */
export interface AnalysisIssue {
  /** feil = ugyldig/motstridende grunnlag (resultatet kan ikke brukes i tilbud), advarsel = må vurderes, antakelse = brukbart, men anslått */
  level: "feil" | "advarsel" | "antakelse";
  /** Feltgruppe i skjemaet: forbruk, produksjon, takflater, tariff, elavgift, avtaler, økonomi, periode, sted */
  field: string;
  message: string;
}

export interface Provenance {
  status: DataStatus;
  sourceType?: SourceType;
  /** Bekreftet for denne kunden/perioden (f.eks. tariff kontrollert mot nettleiefaktura) */
  confirmed?: boolean;
  /** Kort, lesbar kilde: «Elhub-eksport (fil 01)», «PVGIS 6», «Standardprofil kontor» */
  source: string;
  /** Periode verdien gjelder, ISO-datoer i lokal tid */
  period?: { from: string; to: string };
  note?: string;
}

export type SeriesKind = "forbruk" | "produksjon" | "import" | "eksport" | "pris";

/**
 * En tidsserie på fast UTC-rutenett.
 * values[i] gjelder intervallet [startUtc + i*res, startUtc + (i+1)*res).
 * NaN betyr «mangler» – aldri 0.
 */
export interface TimeSeries {
  kind: SeriesKind;
  startUtc: number; // ms
  resolutionMin: 15 | 60;
  values: Float64Array;
  /** "kWh" for energi, "NOK/kWh" for priser */
  unit: "kWh" | "NOK/kWh";
  provenance: Provenance;
  /** Intervaller som er fylt inn/estimert av oss (indekser). Brukes i datakontrollen. */
  estimatedIdx?: number[];
  meterId?: string;
}

/** Ett funn i datakontrollen. */
export interface QualityIssue {
  level: "info" | "advarsel" | "feil";
  code: string;
  message: string;
  count?: number;
  examples?: string[];
}

export interface QualityReport {
  intervals: number;
  expectedIntervals: number;
  resolutionMin: number;
  firstLocal: string;
  lastLocal: string;
  sumKwh: number;
  missing: number;
  duplicates: number;
  estimated: number;
  issues: QualityIssue[];
}
