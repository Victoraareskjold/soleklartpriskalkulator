// Økonomi over levetiden. Nominelle kroner og nominell kalkulasjonsrente, før skatt og finansiering.
// Hvert år regnes energiflyten på nytt med degradert produksjon (ikke «førsteår × vekst»),
// og hver kostnadskomponent får sin egen vekst.

import { simulate, savings, type EngineInput, type EngineResult } from "./engine";

export interface EconomyInput {
  /** null = investeringen er ikke avklart (f.eks. ikke fordelt mellom solceller og batteri) */
  investmentNok: number | null;
  years: number;
  discountRate: number; // 0.0812
  growth: { kraft: number; nettleie: number; avgift: number; drift: number };
  degradationPerYear: number; // 0.004
  opex: { name: string; nokPerYear: number }[];
  replacements: { name: string; year: number; nok: number }[];
  /** Inntekter utenfor strømregningen, f.eks. salg av lading til kjøretøy. growth = årlig prisvekst. */
  revenues?: { name: string; nokPerYear: number; growth: number }[];
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
  /** Inntekt fra lading til kjøretøy (og andre inntekter utenfor strømregningen) */
  ladeinntekt: number;
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
  return lifetimeFrom(before, (t) => simulate({ ...base.after, pvFactor: Math.pow(1 - e.degradationPerYear, t - 1) }), e);
}

type Sav = ReturnType<typeof savings> & { pvKwh: number };

/**
 * Levetidsøkonomi fra et «før»-resultat og en funksjon som regner energiflyten i år t.
 * sampleYears: regn bare disse årene og interpoler lineært mellom dem (for tunge beregninger, f.eks. batteristyring).
 * Første og siste år regnes alltid.
 */
export function lifetimeFrom(before: EngineResult, afterAt: (t: number) => EngineResult, e: EconomyInput, sampleYears?: number[]): EconomyResult {
  const cache = new Map<number, Sav>();
  const exact = (t: number): Sav => {
    let s = cache.get(t);
    if (!s) {
      const a = afterAt(t);
      s = { ...savings(before, a), pvKwh: a.total.pvKwh };
      cache.set(t, s);
    }
    return s;
  };
  const samples = sampleYears ? [...new Set([1, e.years, ...sampleYears.filter((y) => y >= 1 && y <= e.years)])].sort((a, b) => a - b) : null;
  const savAt = (t: number): Sav => {
    if (!samples || samples.includes(t)) return exact(t);
    const hi = samples.find((y) => y > t)!;
    const lo = [...samples].reverse().find((y) => y < t)!;
    const a = exact(lo), b = exact(hi), w = (t - lo) / (hi - lo);
    const out = {} as Sav;
    for (const k of Object.keys(a) as (keyof Sav)[]) out[k] = a[k] + (b[k] - a[k]) * w;
    return out;
  };
  const rows: YearRow[] = [];
  let acc = e.investmentNok == null ? null : -e.investmentNok;
  let pvOps = 0;
  for (let t = 1; t <= e.years; t++) {
    const s = savAt(t);
    const after = { total: { pvKwh: s.pvKwh } };
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
    const ladeinntekt = (e.revenues ?? []).reduce((a, r) => a + r.nokPerYear * Math.pow(1 + r.growth, t - 1), 0);
    // Innmatingskreditt følger nettleien
    const savedInnmating = (s.innmating ?? 0) * gn;
    const netto = savedKraft + savedNettleie + savedInnmating + savedAvgift + salg + ladeinntekt - drift - utskifting;
    const disc = netto / Math.pow(1 + e.discountRate, t);
    pvOps += disc;
    if (acc != null) acc += netto;
    rows.push({ year: t, pvKwh: after.total.pvKwh, savedKraft, savedNettleie: savedNettleie + savedInnmating, savedAvgift, salg, drift, utskifting, ladeinntekt, netto, akkumulert: acc, diskontert: disc });
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
