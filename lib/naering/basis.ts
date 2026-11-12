// Små, rene regler for grunnlaget i analysen (testbare uten database).

/**
 * Investeringen som brukes i beregningen: tilbudssum før støtte, støtte og netto.
 * Støtten trekkes fra én gang. Kunden uten fradragsrett betaler mva. av tilbudssummen; støtten er et kronebeløp.
 */
export function investmentBasis(
  grossExVatNok: number | null,
  support: { source: "tilbud" | "manuell" | "ingen"; nok: number | null },
  quoteSupportNok: number,
  vatDeductible: "ja" | "nei" | "ukjent",
) {
  const vatF = vatDeductible === "nei" ? 1.25 : 1;
  const supportNok = support.source === "ingen" ? 0 : support.source === "manuell" ? (support.nok ?? 0) : quoteSupportNok;
  const grossNok = grossExVatNok == null ? null : grossExVatNok * vatF;
  const netNok = grossNok == null ? null : Math.max(0, grossNok - supportNok);
  return { grossNok, supportNok, netNok, vat: vatF === 1 ? ("eks" as const) : ("inkl" as const), tooLarge: grossNok != null && supportNok > grossNok * 1.0001 };
}

/** Ladevolum oppgitt som andel av samlet forbruk etter at ladingen er lagt til: L / (B + L) = p → L = p·B / (1 − p). */
export function chargeVolumeFromShare(buildingKwh: number, sharePct: number) {
  const p = sharePct / 100;
  return (p * buildingKwh) / (1 - p);
}
