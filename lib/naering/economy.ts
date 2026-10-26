// Økonomi over levetiden. Nominelle kroner og nominell kalkulasjonsrente, før skatt og finansiering.
// Hvert år regnes energiflyten på nytt med degradert produksjon (ikke «førsteår × vekst»),
// og hver kostnadskomponent får sin egen vekst.

import { simulate, savings, type EngineInput } from "./engine";

export interface EconomyInput {
  /** null = investeringen er ikke avklart (f.eks. ikke fordelt mellom solceller og batteri) */
  investmentNok: number | null;
  years: number;
  discountRate: number; // 0.0812
  growth: { kraft: number; nettleie: number; avgift: number; drift: number };
  degradationPerYear: number; // 0.004
  opex: { name: string; nokPerYear: number }[];
  replacements: { name: string; year: number; nok: number }[];
}

export interface YearRow {
  year: number;
  pvKwh: number;
  savedKraft: number;
  savedNettleie: number; // energiledd + effektledd
  savedAvgift: number;
  salg: number;
  drift: number;
  utskifting: number;
  netto: number;
  akkumulert: number | null;
  diskontert: number;
}

export interface EconomyResult {
  rows: YearRow[];
  /** Nåverdi av driftsgevinster = høyeste investering som gir positiv nåverdi */
  pvOfOperations: number;
  npv: number | null;
  paybackYears: number | null;
  discountedPaybackYears: number | null;
  irr: number | null;
  irrNote?: string;
  firstYearNet: number;
}

export function lifetime(base: { before: EngineInput; after: EngineInput }, e: EconomyInput): EconomyResult {
  const before = simulate(base.before); // uten tiltak: uendret over tid i volum
  const rows: YearRow[] = [];
  let acc = e.investmentNok == null ? null : -e.investmentNok;
  let pvOps = 0;
  for (let t = 1; t <= e.years; t++) {
    const f = Math.pow(1 - e.degradationPerYear, t - 1);
    const after = simulate({ ...base.after, pvFactor: f });
    const s = savings(before, after);
    const gk = Math.pow(1 + e.growth.kraft, t - 1);
    const gn = Math.pow(1 + e.growth.nettleie, t - 1);
    const ga = Math.pow(1 + e.growth.avgift, t - 1);
    const gd = Math.pow(1 + e.growth.drift, t - 1);
    const savedKraft = s.kraft * gk;
    const savedNettleie = (s.nettleieEnergi + s.effektledd) * gn;
    const savedAvgift = s.elavgift * ga;
    const salg = s.salg * gk;
    const drift = e.opex.reduce((a, o) => a + o.nokPerYear, 0) * gd;
    const utskifting = e.replacements.filter((r) => r.year === t).reduce((a, r) => a + r.nok, 0); // nominell utbetaling, ikke indeksert
    const netto = savedKraft + savedNettleie + savedAvgift + salg - drift - utskifting;
    const disc = netto / Math.pow(1 + e.discountRate, t);
    pvOps += disc;
    if (acc != null) acc += netto;
    rows.push({ year: t, pvKwh: after.total.pvKwh, savedKraft, savedNettleie, savedAvgift, salg, drift, utskifting, netto, akkumulert: acc, diskontert: disc });
  }

  const inv = e.investmentNok;
  const payback = (vals: number[]) => {
    if (inv == null) return null;
    let a = -inv;
    for (let i = 0; i < vals.length; i++) {
      const prev = a;
      a += vals[i];
      if (a >= 0 && prev < 0) return i + (vals[i] > 0 ? -prev / vals[i] : 0);
    }
    return null; // betaler seg ikke tilbake i perioden
  };
  const cash = rows.map((r) => r.netto);

  let irr: number | null = null;
  let irrNote: string | undefined;
  if (inv != null) {
    const flows = [-inv, ...cash];
    const signChanges = flows.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(flows[i]) && v !== 0).length;
    const npvAt = (r: number) => flows.reduce((a, v, i) => a + v / Math.pow(1 + r, i), 0);
    if (signChanges !== 1) irrNote = "Kontantstrømmen skifter fortegn flere ganger – internrente er ikke entydig, bruk nåverdi.";
    else if (npvAt(-0.99) * npvAt(1) > 0) irrNote = "Ingen internrente i intervallet −99 % til 100 %.";
    else {
      let lo = -0.99, hi = 1;
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2;
        if (npvAt(lo) * npvAt(mid) <= 0) hi = mid;
        else lo = mid;
      }
      irr = (lo + hi) / 2;
    }
  }

  return {
    rows,
    pvOfOperations: pvOps,
    npv: inv == null ? null : pvOps - inv,
    paybackYears: payback(cash),
    discountedPaybackYears: payback(rows.map((r) => r.diskontert)),
    irr,
    irrNote,
    firstYearNet: rows[0]?.netto ?? 0,
  };
}
