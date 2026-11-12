// Nettariffer med datoversjoner (tariffregisteret fra 8.11.2026) og regnereglene for dem.
//
// Én tariff i menyen = ett produkt i ett nettområde (f.eks. «Glitre Nett · Større bedrift – lavspent»,
// tidligere Glitre-område). Produktet har flere prisversjoner; beregningen bruker versjonen som gjelder
// for hver dato. Versjonene lagres som de står i kilden (norske feltnavn), så de kan kontrolleres mot
// prisarket og importeres på nytt.
//
// Regler motoren støtter:
//   energiledd:  lik hele døgnet · sesong (sommer/resten) · dag/natt (06–22 = klokketimene 06–21)
//   fastledd:    kr/mnd eller kr/år, Enova 800 kr/år når den kommer i tillegg
//   effekt:      ett kapasitetstrinn · pris × kW · marginale effektblokker · månedsvekter (Vevig)
//   grunnlag:    høyeste klokketime i måneden · snitt av tre høyeste døgnmakser (ulike datoer) · påstemplet kW
// Regler som ikke er entydige i kilden (høglastvindu uten kalender, dag/natt-sammenstilling, effektintervaller
// uten avregningsregel) regnes ikke: effektleddet blir da ikke med, og analysen får en feil som må avklares.
//
// Den eldre tariffmodellen (én sats, effekt i et vindu, satsendringer) regnes som før via samme grensesnitt.

import type { Tariff } from "./tariff";
import { norwegianHolidays } from "./profiles";

type Num = number;
type Season<T> = { sommermaaneder: number[] | null; sommer: T; resten_av_aaret?: T; vinter?: T };

export type NtEnergy =
  | { modell: "lik_hele_doegnet"; ore_per_kwh: Num }
  | { modell: "sesong"; ore_per_kwh: Season<Num> }
  | {
      modell: "dag_natt";
      dag_fra: string;
      dag_til_eksklusiv: string;
      dag_gjelder: "alle_dager" | "mandag_fredag" | "mandag_fredag_unntatt_helligdager";
      dag_ore_per_kwh: Num;
      ellers_ore_per_kwh: Num;
      helligdag_paa_ukedag?: string;
    };

export interface NtPower {
  modell: "ett_kapasitetstrinn" | "pris_ganger_kw" | "marginale_effektblokker" | "effekt_dag_natt" | "effektintervaller_i_tariffark" | string;
  grunnlag?: string | null;
  maaleintervall_min?: number | null;
  grenser?: "nedre_inklusiv" | "oevre_inklusiv" | "overlapp_i_ark_bekreft_ved_eksakt_grense" | string | null;
  trinn?: { til_kw: number | null; kr_per_mnd: Num }[];
  kr_per_kw_mnd?: Num | Season<Num | { dag: Num; natt: Num }>;
  blokker?: { til_kw: number | null; kr_per_kw_mnd: Num }[];
  maanedsfaktorer_jan_des?: number[];
  effektkalender?: unknown;
  [k: string]: unknown;
}

export interface NtVersion {
  id: string;
  produkt: string;
  omraadeversjon: string;
  dekket_fra: string;
  dekket_til_eksklusiv: string | null;
  kilder: string[];
  status: "kildebelagt" | "maa_avklares" | string;
  fastledd: { kr_per_mnd?: Num; kr_per_aar?: Num };
  energiledd_uttak: NtEnergy;
  kapasitet_eller_effekt: NtPower;
  enova_800_per_aar: "inkludert_i_trinn_eller_fastledd" | "kommer_i_tillegg" | string;
  enova_ekstra_kr_per_aar?: Num | null;
  sperre?: string | null;
  merknad?: string | null;
  reaktivt?: unknown;
  vilkaar_i_denne_versjonen?: string | null;
  publisert_foer_normalisering?: unknown;
}

export interface NtProduct {
  id: string;
  nettselskap: string;
  navn_i_valg: string;
  vilkaar: string;
  valgtype: "ordinaer" | "krever_avtale" | string;
  forslagsvilkaar: {
    maalepunkt_nettomraade: string;
    krever_dokumentert_spesialavtale?: boolean;
    ved_uklar_grense?: string;
    aarsforbruk_kwh?: { lt?: number; gt?: number };
    tilknytningsnivaa?: "lavspent" | "hoeyspent";
    hovedsikring_stoerre_enn_A_ved_V?: Record<string, number>;
    alternativt_vilkaar?: string;
    tilleggsvilkaar?: string;
  };
}

/** Innmating (plusskunde) – oppslag med forbehold, ikke en del av uttakstariffen. */
export interface NtFeedIn {
  nettselskap: string;
  dekket_fra?: string;
  dekket_til_eksklusiv?: string | null;
  pluss_energiledd_ore_per_kwh?: Num;
  publisert_vinterkreditt_ore_per_kwh?: Num;
  vintermaaneder?: number[];
  bruk?: string;
  [k: string]: unknown;
}

/** Tariffdefinisjonen i registeret (calc.tariffs.definition) for nettariffer med datoversjoner. */
export interface GridTariffDefinition {
  format: "nettariff-v1";
  /** Datapakkens versjon og kontrolldato */
  dataVersion: string;
  checked: string;
  /** Siste dato (eksklusiv) pakken dekker. Etter dette er satsene bare et anslag. */
  coveredUntil: string;
  coveredYear: number;
  product: NtProduct;
  area: string;
  areaLabel: string;
  versions: NtVersion[];
  sources: Record<string, { tittel: string; url: string; kontrollert?: string }>;
  feedIn: NtFeedIn[];
  enovaNokPerYear: number;
}

export const isGridDef = (d: unknown): d is GridTariffDefinition => (d as { format?: string } | null)?.format === "nettariff-v1";

export const AREA_LABELS: Record<string, string> = {
  hele_nettomraadet: "",
  glitre_tidligere_agder_buskerud_hadeland: "tidligere Glitre-område (bl.a. Drammen, Kristiansand)",
  tidligere_norgesnett_fredrikstad_mfl: "tidligere Norgesnett-område (bl.a. Fredrikstad)",
};

// ---------------------------------------------------------------------------------------------- hjelpere

const z2 = (x: number) => String(x).padStart(2, "0");
const isoOf = (d: { year: number; month: number; day: number }) => `${d.year}-${z2(d.month)}-${z2(d.day)}`;
const hourOf = (hhmm: string) => Number(hhmm.slice(0, 2));
const DEFAULT_SUMMER = [4, 5, 6, 7, 8, 9];

function seasonal<T>(v: T | Season<T>, month: number): { value: T; assumedMonths: boolean } {
  if (v != null && typeof v === "object" && "sommer" in (v as object)) {
    const s = v as Season<T>;
    const months = s.sommermaaneder ?? DEFAULT_SUMMER;
    const rest = (s.resten_av_aaret ?? s.vinter) as T;
    return { value: months.includes(month) ? s.sommer : rest, assumedMonths: s.sommermaaneder == null };
  }
  return { value: v as T, assumedMonths: false };
}

const POWER_BASIS_LABEL: Record<string, string> = {
  hoeyeste_klokketime_i_maaneden: "høyeste klokketime i måneden",
  snitt_av_tre_hoeyeste_doegnmakser_ulike_datoer: "snitt av de tre høyeste døgnmaksene (ulike datoer)",
  maanedens_effekttopp: "månedens effekttopp (regnet som høyeste klokketime)",
  paastemplet_kw_avtalt_anlegg: "påstemplet effekt i avtalen",
  hoeyeste_time_i_hoeglast: "høyeste time i høglast",
};

export function powerBasisLabel(g: string | null | undefined) {
  return g ? (POWER_BASIS_LABEL[g] ?? g.replaceAll("_", " ")) : "ikke oppgitt";
}

/** Effektgrunnlaget kan regnes ut fra timeverdiene (ellers mangler en regel i kilden). */
function powerProblem(p: NtPower): string | null {
  const g = p.grunnlag ?? null;
  if (p.modell === "effekt_dag_natt") return "Tariffen har egen dag- og nattmaks, men regelen for hvordan de sammenstilles er ikke dokumentert.";
  if (p.modell === "effektintervaller_i_tariffark") return "Tariffarket har effektintervaller, men det er ikke avklart om satsen gjelder marginalt per blokk eller for hele toppen.";
  if (g === "hoeyeste_time_i_hoeglast") return "Effekten måles i høglast, men tariffarket har ingen entydig kalender for høglasttimene.";
  if (g == null) return "Tariffarket oppgir ikke hvordan effekttoppen måles.";
  if (g === "maa_bekreftes_lokal_ls") return "Det er uavklart om effekten måles som høyeste time eller snitt av tre døgnmakser i dette området.";
  if (!(g in POWER_BASIS_LABEL)) return `Ukjent effektgrunnlag «${g}».`;
  if (!["ett_kapasitetstrinn", "pris_ganger_kw", "marginale_effektblokker"].includes(p.modell)) return `Ukjent effektmodell «${p.modell}».`;
  return null;
}

/** Trinnet for en effekt. nedre_inklusiv: [forrige, til) – 5,00 havner i neste trinn. oevre_inklusiv: (forrige, til]. */
export function capacityStep(trinn: { til_kw: number | null; kr_per_mnd: number }[], kw: number, grenser?: string | null) {
  const upperInclusive = grenser === "oevre_inklusiv";
  let from = 0;
  for (let i = 0; i < trinn.length; i++) {
    const t = trinn[i];
    const inside = t.til_kw == null || (upperInclusive ? kw <= t.til_kw + 1e-9 : kw < t.til_kw - 1e-9);
    if (inside) return { index: i, from, to: t.til_kw, nok: t.kr_per_mnd, overTop: false };
    from = t.til_kw ?? from;
  }
  // Over høyeste dokumenterte trinn (Vevig: ingen sats over 1000 kW)
  const last = trinn[trinn.length - 1];
  return { index: trinn.length - 1, from, to: last?.til_kw ?? null, nok: last?.kr_per_mnd ?? 0, overTop: true };
}

/** Marginale blokker: hver blokk prises for kW innenfor blokken. */
export function blockCharge(blokker: { til_kw: number | null; kr_per_kw_mnd: number }[], kw: number) {
  let from = 0, nok = 0;
  const parts: { from: number; to: number; kw: number; rate: number }[] = [];
  for (const b of blokker) {
    const to = b.til_kw ?? Infinity;
    const inBlock = Math.max(0, Math.min(kw, to) - from);
    if (inBlock > 0) {
      nok += inBlock * b.kr_per_kw_mnd;
      parts.push({ from, to, kw: inBlock, rate: b.kr_per_kw_mnd });
    }
    if (kw <= to) break;
    from = to;
  }
  return { nok, parts };
}

/** Effektgrunnlag fra døgnmaksene i måneden (kW per lokal dato). */
export function powerBasis(dayMax: Iterable<number>, grunnlag: string | null | undefined) {
  const vals = [...dayMax].sort((a, b) => b - a);
  const max = vals[0] ?? 0;
  if (grunnlag === "snitt_av_tre_hoeyeste_doegnmakser_ulike_datoer") {
    const top = vals.slice(0, 3);
    return { kw: top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0, days: top };
  }
  return { kw: max, days: vals.slice(0, 1) };
}

// ---------------------------------------------------------------------------------------------- kompilert tariff

export interface MonthGrid {
  /** Prisversjonen som er brukt (id fra registeret), null for eldre tariffer */
  versionId: string | null;
  /** Satsene er hentet fra et annet år enn forbruket (anslag) */
  shiftedFrom: string | null;
  fixedNok: number;
  enovaNok: number;
  effektNok: number;
  /** Fakturert effekt (kW) i måneden, null = ikke effektbasert/ukjent */
  billedKw: number | null;
  /** Kort tekst: «Trinn 25–50 kW», «200 kW × 102 kr», «påstemplet 150 kW» */
  billedLabel: string;
  /** Hvordan effekten er målt */
  basis: string;
  /** Effektleddet kunne ikke beregnes (delberegning) */
  powerMissing: string | null;
}

export interface CompiledTariff {
  kind: "nettariff-v1" | "eldre";
  /** Energiledd uttak, kr/kWh, for timen (lokal tid) */
  energyNok(lp: LocalDate & { hour: number; weekday: number }): number;
  /** Innmating, kr/kWh (negativ = kreditt på nettfakturaen). 0 = ikke med. */
  exportNok(lp: LocalDate): number;
  /** Timen teller i effektgrunnlaget */
  inWindow(lp: LocalDate & { hour: number; weekday: number }): boolean;
  /** Omtrentlig kostnad per kW økt månedstopp (kr), brukt av batteristyringen */
  plannerRate(lp: LocalDate): number;
  /** Effekten måles per kvarter (ellers klokketime) */
  quarterMeasure: boolean;
  /** Avregning for måneden */
  month(m: { year: number; month: number; daysCovered: number; fullDays: number; yearDays: number }, dayMax: Map<string, number>, peakKw: number): MonthGrid;
  /** Forbehold som skal vises (sperrer, antakelser, manglende regler) – samlet under kjøringen */
  notes: Set<string>;
  /** Regler som mangler, så nettleien er en delberegning */
  missing: Set<string>;
  /** Satser lånt fra et annet år (anslag) */
  shifted: Set<string>;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface CompileOptions {
  /** Påstemplet effekt (kW) for avtaler som bruker den */
  contractedKw?: number | null;
  /** Kunden har plusskundeavtale: innmatingstariffens energiledd tas med som kreditt */
  feedIn?: boolean;
}

export function compileTariff(t: Tariff, opts: CompileOptions = {}): CompiledTariff {
  return t.grid ? compileGrid(t.grid, opts) : compileLegacy(t);
}

function compileLegacy(t: Tariff): CompiledTariff {
  const holidays = new Map<number, Set<string>>();
  const hol = (y: number) => {
    let h = holidays.get(y);
    if (!h) holidays.set(y, (h = norwegianHolidays(y)));
    return h;
  };
  const rateAt = (d: LocalDate) => {
    const iso = isoOf(d);
    const r = { energyOrePerKwh: t.energyOrePerKwh, summerNokPerKwMonth: t.power?.summerNokPerKwMonth ?? 0, winterNokPerKwMonth: t.power?.winterNokPerKwMonth ?? 0 };
    for (const c of [...(t.rateChanges ?? [])].sort((a, b) => a.from.localeCompare(b.from)))
      if (c.from <= iso) {
        if (c.energyOrePerKwh != null) r.energyOrePerKwh = c.energyOrePerKwh;
        if (c.summerNokPerKwMonth != null) r.summerNokPerKwMonth = c.summerNokPerKwMonth;
        if (c.winterNokPerKwMonth != null) r.winterNokPerKwMonth = c.winterNokPerKwMonth;
      }
    return r;
  };
  const pw = t.power;
  const peakRateAt = (d: LocalDate) => {
    const r = rateAt(d);
    return pw ? (pw.summerMonths.includes(d.month) ? r.summerNokPerKwMonth : r.winterNokPerKwMonth) : 0;
  };
  return {
    kind: "eldre",
    energyNok: (lp) => rateAt(lp).energyOrePerKwh / 100,
    exportNok: () => 0,
    inWindow: (lp) =>
      !!pw &&
      pw.window.weekdays.includes(lp.weekday) &&
      lp.hour >= pw.window.fromHour &&
      lp.hour < pw.window.toHour &&
      !(pw.window.excludeHolidays && hol(lp.year).has(isoOf(lp))),
    plannerRate: peakRateAt,
    quarterMeasure: pw?.resolution === "kvarter",
    month: (m, _dayMax, peakKw) => {
      const fixedNokPerYear = t.fixedNokPerYear;
      const fixedNok = t.fixedAllocation === "per_dag" ? (fixedNokPerYear / m.yearDays) * m.daysCovered : (fixedNokPerYear / 12) * (m.daysCovered / m.fullDays);
      const rate = pw ? peakRateAt({ year: m.year, month: m.month, day: 1 }) : 0;
      return {
        versionId: null,
        shiftedFrom: null,
        fixedNok,
        enovaNok: 0,
        effektNok: pw ? peakKw * rate : 0,
        billedKw: pw ? peakKw : null,
        billedLabel: pw ? `${nf(peakKw, 1)} kW × ${nf(rate, 2)} kr` : "",
        basis: pw ? `høyeste time kl. ${z2(pw.window.fromHour)}–${z2(pw.window.toHour)}${pw.window.weekdays.length < 7 ? " på hverdager" : ""}` : "ingen effekt",
        powerMissing: null,
      };
    },
    notes: new Set(),
    missing: new Set(),
    shifted: new Set(),
  };
}

const nf = (x: number, d = 0) => x.toLocaleString("nb-NO", { maximumFractionDigits: d, minimumFractionDigits: 0 });

/** Versjonen som gjelder en dato. Utenfor pakken: samme dato i nærmeste dekkede år (anslag). */
export function versionAt(def: GridTariffDefinition, d: LocalDate): { v: NtVersion | null; shiftedFrom: string | null } {
  const iso = isoOf(d);
  const covered = (x: string) => def.versions.find((v) => v.dekket_fra <= x && (v.dekket_til_eksklusiv ?? def.coveredUntil) > x) ?? null;
  const hit = iso < def.coveredUntil ? covered(iso) : null;
  if (hit) return { v: hit, shiftedFrom: null };
  // Låner satsene fra pakkens år (29. februar → 28. februar)
  const y = def.coveredYear;
  const day = d.month === 2 && d.day === 29 ? 28 : d.day;
  const alt = `${y}-${z2(d.month)}-${z2(day)}`;
  const v = covered(alt);
  return { v, shiftedFrom: v ? String(y) : null };
}

function compileGrid(def: GridTariffDefinition, opts: CompileOptions): CompiledTariff {
  const notes = new Set<string>();
  const missing = new Set<string>();
  const shifted = new Set<string>();
  const holidays = new Map<number, Set<string>>();
  const hol = (y: number) => {
    let h = holidays.get(y);
    if (!h) holidays.set(y, (h = norwegianHolidays(y)));
    return h;
  };
  const cache = new Map<string, { v: NtVersion | null; shiftedFrom: string | null }>();
  const at = (d: LocalDate) => {
    const k = isoOf(d);
    let r = cache.get(k);
    if (!r) {
      r = versionAt(def, d);
      cache.set(k, r);
      if (r.shiftedFrom) shifted.add(r.shiftedFrom);
      if (r.v) {
        if (r.v.sperre) notes.add(`Må avklares: ${r.v.sperre}`);
        if (r.v.status === "maa_avklares" && !r.v.sperre) notes.add("Prisversjonen er merket «må avklares» i tariffregisteret.");
        const e = r.v.energiledd_uttak;
        if (e.modell === "sesong" && e.ore_per_kwh.sommermaaneder == null) notes.add("Sesongmånedene for energileddet er ikke oppgitt i kilden; regnet med sommer april–september.");
        if (e.modell === "dag_natt" && e.helligdag_paa_ukedag) notes.add("Helligdager på ukedager er regnet som dag (må bekreftes mot tariffen).");
        const p = r.v.kapasitet_eller_effekt;
        if (p.grenser === "overlapp_i_ark_bekreft_ved_eksakt_grense") notes.add("Trinngrensene overlapper i prisarket; en effekt nøyaktig på en grense må bekreftes mot faktura.");
        if (p.reaktivt != null || r.v.reaktivt != null) notes.add("Reaktiv effekt/energi er ikke med (krever egne målinger).");
      }
    }
    return r;
  };
  const versionOrThrow = (d: LocalDate) => {
    const r = at(d);
    if (!r.v) throw new Error(`Tariffen «${def.product.navn_i_valg}» har ingen prisversjon for ${isoOf(d)}.`);
    return r.v;
  };

  const energyNok = (lp: LocalDate & { hour: number; weekday: number }) => {
    const e = versionOrThrow(lp).energiledd_uttak;
    if (e.modell === "lik_hele_doegnet") return e.ore_per_kwh / 100;
    if (e.modell === "sesong") return seasonal(e.ore_per_kwh, lp.month).value / 100;
    const inHours = lp.hour >= hourOf(e.dag_fra) && lp.hour < (hourOf(e.dag_til_eksklusiv) || 24);
    const weekdayOk =
      e.dag_gjelder === "alle_dager" ||
      (lp.weekday <= 5 && (e.dag_gjelder === "mandag_fredag" || !hol(lp.year).has(isoOf(lp))));
    return (inHours && weekdayOk ? e.dag_ore_per_kwh : e.ellers_ore_per_kwh) / 100;
  };

  // Innmating: energiledd for plusskunder (kreditt), når kunden har avtalen
  const feed = (def.feedIn ?? []).filter((f) => f.pluss_energiledd_ore_per_kwh != null || f.publisert_vinterkreditt_ore_per_kwh != null);
  const exportNok = (d: LocalDate) => {
    if (!opts.feedIn) return 0;
    const iso = isoOf(d);
    const f = feed.find((x) => (!x.dekket_fra || x.dekket_fra <= iso) && (!x.dekket_til_eksklusiv || x.dekket_til_eksklusiv > iso)) ?? feed.find((x) => !x.dekket_fra) ?? null;
    if (!f) return 0;
    if (f.pluss_energiledd_ore_per_kwh != null) return f.pluss_energiledd_ore_per_kwh / 100;
    if (f.publisert_vinterkreditt_ore_per_kwh != null && (f.vintermaaneder ?? []).includes(d.month)) return f.publisert_vinterkreditt_ore_per_kwh / 100;
    return 0;
  };
  if (opts.feedIn && !feed.length) notes.add(`Innmatingstariff for ${def.product.nettselskap} finnes ikke i registeret; kreditt for innmating er ikke med.`);
  if (opts.feedIn && feed.length) notes.add(`Innmating: plusskundens energiledd er tatt med som kreditt (${feed.map((f) => f.bruk).filter(Boolean)[0] ?? "kontroller avtalen"}). Fastledd for innmating er ikke med.`);

  const rateAt = (p: NtPower, month: number) => {
    const r = p.kr_per_kw_mnd;
    if (r == null) return 0;
    const v = seasonal(r as number | Season<number>, month).value;
    const w = p.maanedsfaktorer_jan_des?.[month - 1] ?? 1;
    return (typeof v === "number" ? v : 0) * w;
  };

  const plannerRate = (d: LocalDate) => {
    const v = at(d).v;
    if (!v) return 0;
    const p = v.kapasitet_eller_effekt;
    if (powerProblem(p) || p.grunnlag === "paastemplet_kw_avtalt_anlegg") return 0;
    const div = p.grunnlag === "snitt_av_tre_hoeyeste_doegnmakser_ulike_datoer" ? 3 : 1;
    if (p.modell === "pris_ganger_kw") return rateAt(p, d.month) / div;
    if (p.modell === "marginale_effektblokker") return (p.blokker?.[0]?.kr_per_kw_mnd ?? 0) / div;
    if (p.modell === "ett_kapasitetstrinn" && p.trinn?.length) {
      // Typisk merkostnad per kW mellom trinnene
      const slopes: number[] = [];
      let prevKw = 0, prevNok = p.trinn[0].kr_per_mnd;
      for (const t of p.trinn.slice(1)) {
        const top = t.til_kw ?? prevKw * 1.5 + 1;
        const width = Math.max(1, top - prevKw);
        slopes.push((t.kr_per_mnd - prevNok) / width);
        prevKw = top;
        prevNok = t.kr_per_mnd;
      }
      slopes.sort((a, b) => a - b);
      return Math.max(0, slopes[Math.floor(slopes.length / 2)] ?? 0) / div;
    }
    return 0;
  };

  const month: CompiledTariff["month"] = (m, dayMax) => {
    const first = { year: m.year, month: m.month, day: 1 };
    const { v, shiftedFrom } = at(first);
    if (!v) throw new Error(`Tariffen «${def.product.navn_i_valg}» har ingen prisversjon for ${m.year}-${z2(m.month)}.`);
    const frac = m.daysCovered / m.fullDays;
    const f = v.fastledd;
    const fixedNok = (f.kr_per_mnd != null ? f.kr_per_mnd : (f.kr_per_aar ?? 0) / 12) * frac;
    const enovaNok = v.enova_800_per_aar === "kommer_i_tillegg" ? ((def.enovaNokPerYear + (v.enova_ekstra_kr_per_aar ?? 0)) / 12) * frac : ((v.enova_ekstra_kr_per_aar ?? 0) / 12) * frac;
    const p = v.kapasitet_eller_effekt;
    const problem = powerProblem(p);
    const base: MonthGrid = { versionId: v.id, shiftedFrom, fixedNok, enovaNok, effektNok: 0, billedKw: null, billedLabel: "", basis: powerBasisLabel(p.grunnlag), powerMissing: null };
    if (problem) {
      missing.add(problem);
      return { ...base, powerMissing: problem, billedLabel: "ikke beregnet" };
    }
    let kw: number;
    if (p.grunnlag === "paastemplet_kw_avtalt_anlegg") {
      if (opts.contractedKw == null) {
        const msg = "Tariffen bruker påstemplet effekt i avtalen. Legg inn påstemplet kW for målepunktet.";
        missing.add(msg);
        return { ...base, powerMissing: msg, billedLabel: "påstemplet kW mangler" };
      }
      kw = opts.contractedKw;
      notes.add("Effektleddet følger påstemplet effekt; kutt i målt topp gir ingen besparelse i effektleddet.");
    } else kw = powerBasis(dayMax.values(), p.grunnlag).kw;

    if (p.modell === "ett_kapasitetstrinn" && p.trinn?.length) {
      const st = capacityStep(p.trinn, kw, p.grenser);
      if (st.overTop) notes.add(`Effekten er over høyeste dokumenterte trinn (${st.from} kW); regnet med øverste trinn.`);
      return {
        ...base,
        effektNok: st.nok,
        billedKw: kw,
        billedLabel: st.to == null ? `trinn over ${nf(st.from)} kW` : `trinn ${nf(st.from)}–${nf(st.to)} kW`,
      };
    }
    if (p.modell === "marginale_effektblokker" && p.blokker?.length) {
      const b = blockCharge(p.blokker, kw);
      return { ...base, effektNok: b.nok, billedKw: kw, billedLabel: `${nf(kw, 1)} kW i ${b.parts.length} blokk${b.parts.length === 1 ? "" : "er"}` };
    }
    const rate = rateAt(p, m.month);
    const w = p.maanedsfaktorer_jan_des?.[m.month - 1];
    return { ...base, effektNok: kw * rate, billedKw: kw, billedLabel: `${nf(kw, 1)} kW × ${nf(rate, 2)} kr${w != null && w !== 1 ? ` (vekt ${nf(w, 1)})` : ""}` };
  };

  const firstMeasure = def.versions[0]?.kapasitet_eller_effekt.maaleintervall_min;
  return {
    kind: "nettariff-v1",
    energyNok,
    exportNok,
    inWindow: (lp) => {
      const v = at(lp).v;
      if (!v) return false;
      const p = v.kapasitet_eller_effekt;
      return !powerProblem(p) && p.grunnlag !== "paastemplet_kw_avtalt_anlegg";
    },
    plannerRate,
    quarterMeasure: firstMeasure === 15,
    month,
    notes,
    missing,
    shifted,
  };
}

// ---------------------------------------------------------------------------------------------- forslag

export interface SuggestInput {
  /** Nettselskapets kode (EL, GL …) og område */
  companyCode: string | null;
  area: string | null;
  annualKwh: number | null;
  level: "lavspent" | "hoeyspent" | null;
  mainFuseA: number | null;
  voltageV: 230 | 400 | null;
}

export interface SuggestCandidate {
  productId: string;
  area: string;
  name: string;
  /** foreslått = entydig ordinært treff, mulig = passer, men noe må bekreftes, avtale = bare med særskilt avtale */
  fit: "foreslått" | "mulig" | "avtale";
  reasons: string[];
  blocked: string | null;
}

/**
 * Forslag til tariff for målepunktet ut fra nettselskap, område, årsforbruk, spenningsnivå og hovedsikring.
 * Bare ordinære, entydige treff foreslås. Avtaler og «må avklares» vises, men velges aldri automatisk.
 */
export function suggestTariff(products: { def: GridTariffDefinition; date: string }[], q: SuggestInput): SuggestCandidate[] {
  const out: SuggestCandidate[] = [];
  for (const { def, date } of products) {
    const p = def.product;
    if (q.companyCode && p.forslagsvilkaar.maalepunkt_nettomraade !== q.companyCode) continue;
    if (q.area && def.area !== "hele_nettomraadet" && def.area !== q.area) continue;
    const reasons: string[] = [];
    const doubts: string[] = [];
    const v = p.forslagsvilkaar;
    let ok = true;
    const kwh = q.annualKwh;
    if (v.aarsforbruk_kwh) {
      const { lt, gt } = v.aarsforbruk_kwh;
      const fuseBig = v.hovedsikring_stoerre_enn_A_ved_V && q.mainFuseA != null && q.voltageV != null ? q.mainFuseA > (v.hovedsikring_stoerre_enn_A_ved_V[String(q.voltageV)] ?? Infinity) : null;
      let byFuse = false;
      const onLimit = kwh != null && (kwh === lt || kwh === gt);
      if (kwh == null) doubts.push("årsforbruket er ikke oppgitt");
      else if (onLimit) doubts.push(`årsforbruket er nøyaktig ${nf(kwh)} kWh – på grensen mellom produktene, kontroller faktura`);
      else if (lt != null && kwh >= lt) {
        // Lede: årsforbruk over grensen, men liten hovedsikring gir fortsatt kapasitetstrinn
        if (p.id === "LD.K" && q.mainFuseA != null && q.voltageV != null) {
          const lim = q.voltageV === 230 ? 160 : 100;
          if (q.mainFuseA <= lim) {
            byFuse = true;
            reasons.push(`årsforbruk ${nf(kwh)} kWh, men hovedsikring ${q.mainFuseA} A ved ${q.voltageV} V (≤ ${lim} A)`);
          } else ok = false;
        } else ok = false;
      } else if (gt != null && kwh <= gt) ok = false;
      if (ok && kwh != null && !byFuse && !onLimit)
        reasons.push(lt != null ? `årsforbruk ${nf(kwh)} kWh (under ${nf(lt)})` : `årsforbruk ${nf(kwh)} kWh (over ${nf(gt ?? 0)})`);
      if (ok && fuseBig === false && p.id === "LD.L") ok = false;
      if (ok && fuseBig === true) reasons.push(`hovedsikring ${q.mainFuseA} A ved ${q.voltageV} V`);
      if (ok && p.id === "LD.L" && fuseBig == null) doubts.push("hovedsikringen er ikke oppgitt");
    }
    if (!ok) continue;
    if (v.tilknytningsnivaa) {
      if (q.level == null) doubts.push("spenningsnivået er ikke oppgitt");
      else if (q.level !== v.tilknytningsnivaa) continue;
      else reasons.push(v.tilknytningsnivaa === "lavspent" ? "lavspent tilknytning" : "høyspent tilknytning");
    } else if (q.level === "hoeyspent" && p.id.endsWith(".K")) continue;
    const ver = versionAt(def, { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10) }).v;
    const blocked = ver?.sperre ?? (ver?.status === "maa_avklares" ? "Prisversjonen er merket «må avklares»." : null);
    const agreement = p.valgtype !== "ordinaer" || v.krever_dokumentert_spesialavtale === true;
    if (v.tilleggsvilkaar) doubts.push(v.tilleggsvilkaar);
    if (def.area !== "hele_nettomraadet") reasons.push(`område: ${def.areaLabel}`);
    out.push({
      productId: p.id,
      area: def.area,
      name: def.product.navn_i_valg + (def.areaLabel ? ` (${def.areaLabel})` : ""),
      fit: agreement ? "avtale" : blocked || doubts.length ? "mulig" : "foreslått",
      reasons: [...reasons, ...doubts.map((d) => `må bekreftes: ${d}`)],
      blocked,
    });
  }
  const order = { foreslått: 0, mulig: 1, avtale: 2 } as const;
  return out.sort((a, b) => order[a.fit] - order[b.fit]);
}
