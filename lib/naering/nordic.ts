// Smart batteristyring: Nordic Solergy sin planlegger (nordic-solergy/smart-batteri.js, urørt).
//
// Denne fila er bare innpakningen. Den legger våre data inn i Nordic Solergys rutenett (8760 timer,
// 1. januar kl. 00 = indeks 0, uten 29. februar), kjører planleggeren og fører planen tilbake til motorens
// intervaller. Selve styringen (dynamisk programmering over 36 timer, tak for effekttoppen per måned,
// 15 % krav om fortjeneste ved nettlading osv.) er deres, og skal gi samme plan time for time som i
// beregningen deres med samme grunnlag. Se nordic-solergy/SMART-BATTERI-BESKRIVELSE.md.
//
// Det vi tilpasser, gjennom innstillingene fila selv åpner for (INNSTILLINGER):
//  • virkningsgrad: batteriets egen (√ tur-retur), så planen og motorens energibalanse stemmer.
//  • startNivaa 0: batteriet starter på reservenivået, som i resten av motoren (ingen gratis energi).
//  • margin: svært høy når lading fra nett ikke er tillatt, så planen ikke lader fra nettet.
// Alt annet er Nordic Solergys standard.
//
// Tilpasning av data:
//  • Forbruk, sol og priser er motorens egne (vår tariff, spot, påslag, elavgift og avtaler).
//  • Kvarter summeres til timer for planen, og timeplanen fordeles likt på kvarterene.
//  • Høsttimen som kommer to ganger: planen gjelder den første, batteriet står stille i den andre.
//    Vårtimen som mangler: batteriet står stille den timen.
//  • 29. februar: batteriet står stille (rutenettet har ikke dagen).
//  • Timer utenfor perioden (delår): ingen last, ingen salgsverdi og svært dyr kjøpspris, så batteriet står stille.
//  • Effektleddet: se tilTariff().

import SB, { type SbTariff } from "./nordic-solergy/smart-batteri.js";
import { blockCharge, capacityStep, type CompiledTariff, type PlannerPower } from "./gridtariff";

const TIMER = 8760;

export interface NordicInput {
  n: number;
  fromUtc: number;
  stepMin: 15 | 60;
  /** Lokal dato og time per intervall */
  year: Int16Array;
  month: Int8Array; // 1–12
  day: Int8Array;
  hour: Int8Array;
  /** Forbruk (med hjelpelast) minus sol per intervall, kWh. Positiv = kjøp. */
  net: Float64Array;
  /** Kjøps- og salgspris per intervall, kr/kWh (som motoren regner med) */
  buyNok: Float64Array;
  sellNok: Float64Array;
  tariff: CompiledTariff;
  /** Brukbar kapasitet over reservenivået (kWh) */
  kapKwh: number;
  /** Maks effekt inn og ut (kW) */
  kw: number;
  /** Virkningsgrad hver vei */
  eta: number;
  gridCharge: boolean;
}

export interface NordicResult {
  /** AC-energi per intervall, motorens fortegn: + utlading, − lading (kWh) */
  b: Float64Array;
  /** Lagret energi over reservenivået ved periodens start ifølge planen (kWh) */
  startKwh: number;
  /** Valgt tak for kjøp fra nettet per kalendermåned (kW, Infinity = intet tak) */
  tak: number[];
  /** Forbehold om tilpasningen (vises i analysen) */
  notes: string[];
}

const mndAv = (g: number) => SB.mndFraIndeks(g);

/**
 * Effektleddet til Nordic Solergys format. Planleggeren bruker det bare til å velge taket for kjøp fra nettet
 * i hver måned; selve nettleien regnes etterpå av motoren med vår tariff.
 *  • Kapasitetstrinn målt som snitt av tre døgntopper, like trinn hele året → deres «trinn» (eksakt).
 *  • Uten effektledd → ingen tariff.
 *  • Ellers → deres «effekt» (høyeste time × sats). Satsen per måned er vår sats (kr/kW), eller for trinn og
 *    marginale blokker gjennomsnittlig besparelse per kW når toppen tas ned med batteriets effekt.
 */
export function tilTariff(power: (PlannerPower | null)[], peakKw: number[], kw: number): { tariff: SbTariff | null; notes: string[] } {
  const notes: string[] = [];
  const real = power.filter((p): p is PlannerPower => p != null);
  const trinn = real.length > 0 && real.every((p) => p.model === "trinn" && p.treDoegn) ? (real as Extract<PlannerPower, { model: "trinn" }>[]) : null;
  if (trinn && trinn.every((p) => JSON.stringify(p.trinn) === JSON.stringify(trinn[0].trinn))) {
    let fra = 0;
    const rows: [number, number | null, number][] = trinn[0].trinn.map((t) => {
      const r: [number, number | null, number] = [fra, t.til_kw, t.kr_per_mnd];
      fra = t.til_kw ?? fra;
      return r;
    });
    if (trinn[0].grenser === "oevre_inklusiv") notes.push("Kapasitetstrinnene er øvre inklusive i tariffen; batteristyringen regner nedre inklusive (bare avvik ved en effekt nøyaktig på en grense).");
    return { tariff: { type: "trinn", trinn: rows }, notes };
  }
  const rate = power.map((p, m) => {
    if (!p || p.model === "ingen") return 0;
    if (p.model === "sats") return p.nokPerKw;
    const top = Math.max(0, peakKw[m]);
    const lo = Math.max(0, top - kw);
    const width = top - lo;
    if (width <= 1e-9) return 0;
    const cost = (x: number) => (p.model === "trinn" ? capacityStep(p.trinn, x, p.grenser).nok : blockCharge(p.blokker, x).nok);
    return Math.max(0, (cost(top) - cost(lo)) / width);
  });
  if (real.some((p) => p.model === "trinn" || p.model === "blokker"))
    notes.push("Batteristyringen har regnet effektleddet som en sats per kW (gjennomsnittlig besparelse når toppen tas ned). Nettleien i resultatet er regnet med tariffens egne trinn eller blokker.");
  if (real.some((p) => p.model === "trinn" && !p.treDoegn))
    notes.push("Kapasitetstrinnet måles på høyeste time; batteristyringen har regnet med høyeste time i måneden.");
  // Uten effektledd får planleggeren ingen tariff (som i beskrivelsen: da prøves ingen tak for effekttoppen)
  if (rate.every((r) => r === 0)) return { tariff: null, notes };
  const distinct = [...new Set(rate.map((r) => Math.round(r * 1e6) / 1e6))];
  if (distinct.length <= 2) {
    const vinter = distinct[0] ?? 0;
    const sommer = distinct[1] ?? vinter;
    const vinterMnd = rate.map((r, m) => (Math.round(r * 1e6) / 1e6 === vinter ? m : -1)).filter((m) => m >= 0);
    return { tariff: { type: "effekt", effektVinter: vinter, effektSommer: sommer, vinterMnd }, notes };
  }
  // Flere enn to satser i året (f.eks. månedsfaktorer): satsen for måneden leses idet planleggeren spør om
  // måneden er vinter (erVinter kalles rett før satsen leses i effektMnd).
  let cur = 0;
  const tariff = {
    type: "effekt" as const,
    vinterMnd: { includes: (m: number) => ((cur = m), true) },
    get effektVinter() {
      return rate[cur] ?? 0;
    },
    effektSommer: 0,
  };
  return { tariff, notes };
}

export function planNordic(o: NordicInput): NordicResult {
  const b = new Float64Array(o.n);
  const empty: NordicResult = { b, startKwh: 0, tak: new Array(12).fill(Infinity), notes: [] };
  if (o.kapKwh <= 1e-6 || o.kw <= 1e-9 || o.n === 0) return empty;
  const stepH = o.stepMin / 60;
  const D = SB.DAG_FOR_MND;

  // ---- inn i rutenettet
  const g = new Int32Array(o.n).fill(-1);
  const first = new Float64Array(TIMER).fill(NaN); // første UTC-time som bruker rutetimen
  const net = new Float64Array(TIMER), kjop = new Float64Array(TIMER), salg = new Float64Array(TIMER), cnt = new Int32Array(TIMER);
  for (let i = 0; i < o.n; i++) {
    const mo = o.month[i], d = o.day[i];
    if (mo === 2 && d === 29) continue;
    const k = (D[mo - 1] + d - 1) * 24 + o.hour[i];
    const uh = Math.floor((o.fromUtc + i * o.stepMin * 60_000) / 3_600_000);
    if (Number.isNaN(first[k])) first[k] = uh;
    else if (first[k] !== uh) {
      if (uh - first[k] > 1) throw new Error("Smart batteristyring regner på inntil ett år om gangen.");
      continue; // høsttimen som kommer to ganger
    }
    g[i] = k;
    net[k] += o.net[i];
    kjop[k] += o.buyNok[i];
    salg[k] += o.sellNok[i];
    cnt[k]++;
  }
  let maxKjop = 0;
  for (let k = 0; k < TIMER; k++)
    if (cnt[k]) {
      kjop[k] /= cnt[k];
      salg[k] /= cnt[k];
      maxKjop = Math.max(maxKjop, Math.abs(kjop[k]));
    }
  const dyr = 10 * maxKjop + 10;
  let utenfor = 0;
  for (let k = 0; k < TIMER; k++) {
    if (cnt[k]) continue;
    // Timen finnes ikke i perioden (vårtimen, hull eller utenfor delperioden): batteriet skal stå stille
    net[k] = 0;
    kjop[k] = dyr;
    salg[k] = 0;
    utenfor++;
  }

  // ---- effektleddet per kalendermåned
  const power: (PlannerPower | null)[] = new Array(12).fill(null);
  const peak = new Array(12).fill(0);
  for (let i = 0; i < o.n; i++) {
    if (g[i] < 0) continue;
    const m = o.month[i] - 1;
    if (!power[m]) power[m] = o.tariff.plannerPower({ year: o.year[i], month: o.month[i], day: o.day[i] });
  }
  for (let k = 0; k < TIMER; k++) if (cnt[k]) peak[mndAv(k)] = Math.max(peak[mndAv(k)], net[k]);
  const { tariff, notes } = tilTariff(power, peak, o.kw);
  if (utenfor > 2 && utenfor < TIMER) notes.push("Delperiode: batteristyringen er planlagt for timene i perioden; batteriet står stille utenfor.");

  // ---- planen
  const S = SB.INNSTILLINGER;
  const saved = { ...S };
  let plan;
  try {
    S.virkningsgrad = o.eta;
    S.startNivaa = 0;
    if (!o.gridCharge) S.margin = 1e6;
    plan = SB.planlegg({ net, kjop, salg, kap: o.kapKwh, kw: o.kw, tariff, mvaF: 1 });
  } finally {
    Object.assign(S, saved);
  }

  // Lagret energi (DC) gjennom året ifølge planen
  const soc = new Float64Array(TIMER + 1);
  for (let k = 0; k < TIMER; k++) {
    const a = plan.ac[k];
    soc[k + 1] = Math.max(0, Math.min(o.kapKwh, soc[k] + (a > 0 ? a * o.eta : a / o.eta)));
  }

  // ---- tilbake til motorens intervaller
  let firstK = -1;
  for (let i = 0; i < o.n; i++) {
    if (g[i] < 0) continue;
    if (firstK < 0) firstK = g[i];
    b[i] = -plan.ac[g[i]] * stepH; // timeplanen fordelt likt på kvarterene
  }
  return { b, startKwh: firstK < 0 ? 0 : soc[firstK], tak: plan.tak, notes };
}
