// Beregningsmotoren: energiflyt per time og regning per måned.
// Ren funksjon – samme grunnlag gir alltid samme svar. Ingen I/O.
//
// Per time bak ett målepunkt:
//   sol (etter inverterkapping) dekker forbruket direkte; batteriet (valgfritt) lader eller lader ut
//   (AC-siden); resten går til eller fra nettet.
//   eksport ≤ eksportgrense (sol kappes først, deretter batteriets salg), import over importgrensen telles.
// Kostnad:
//   kraft    = import × (spot + påslag)          + månedsgebyr (forsvinner ikke med solceller)
//   nettleie = fastledd + import × energiledd + effektledd(maks import i vinduet)
//   avgift   = import × elavgift                  (også strøm som lades inn i batteriet – vanlig avgiftsplikt)
//   salg     = eksport × (spot − fratrekk)       (kan bli negativ ved negative priser)
//
// Batteriet: én samlet energibalanse og ladetilstand gjennom hele perioden (se battery.ts).
// Start- og sluttbeholdning er lik (reservenivået), så tom- eller fullt batteri ved start/slutt gir ingen gratis energi.

import type { TimeSeries } from "./types";
import type { BuyAgreement, SellAgreement, Taxes, Tariff } from "./tariff";
import { fmtLocal, osloParts } from "./time";
import { norwegianHolidays } from "./profiles";
import { planHorizon, type BatteryConfig } from "./battery";

export const ENGINE_VERSION = "naering-0.3.0";

export type { BatteryConfig };

export interface EngineInput {
  load: TimeSeries;
  pv?: TimeSeries | null;
  /** Skalering av PV (degradering i år t). 1 = som serien. */
  pvFactor?: number;
  spot: TimeSeries;
  buy: BuyAgreement;
  sell: SellAgreement;
  tariff: Tariff;
  taxes: Taxes;
  exportLimitKw?: number | null;
  /** Største samtidige uttak fra nettet (kW). Batteriet lader ikke over grensen; timer over grensen telles. */
  importLimitKw?: number | null;
  /** Invertere(nes) samlede AC-effekt. Solproduksjonen kappes her (null = ukjent, ingen kapping). */
  inverterAcKw?: number | null;
  /** Batteri bak samme målepunkt (null = uten batteri) */
  battery?: BatteryConfig | null;
  /** Beregningsoppløsning i minutter (60 eller 15). Standard: forbruksseriens oppløsning. */
  stepMin?: 15 | 60;
  /** Analyseperiode [fra, til) i UTC. Standard: hele forbruksserien. */
  fromUtc?: number;
  toUtc?: number;
}

export interface BatteryMonth {
  /** AC-energi inn i batteriet */
  chargeKwh: number;
  solarChargeKwh: number;
  gridChargeKwh: number;
  /** AC-energi ut av batteriet */
  dischargeKwh: number;
  toLoadKwh: number;
  toGridKwh: number;
  /** Tap i lading/utlading (inn − ut − endring i lagret energi) */
  lossKwh: number;
  /** Hjelpelast (styring, kjøling) */
  auxKwh: number;
  /** Kjøpskostnad for strøm fra nettet til batteriet (kraft + energiledd + elavgift) */
  gridChargeCostNok: number;
  /** Salgsinntekt for strøm fra batteriet til nettet */
  toGridRevenueNok: number;
  /** Fulle sykluser (utladet DC-energi / brukbar kapasitet) */
  cycles: number;
}

export interface MonthResult {
  month: string; // "2024-01"
  days: number;
  loadKwh: number;
  pvKwh: number;
  /** Solstrøm brukt i bygget: direkte + via batteriet (bare solandelen av batteriets energi) */
  selfKwh: number;
  importKwh: number;
  exportKwh: number;
  curtailedKwh: number;
  /** Produksjon som går tapt fordi inverteren er mindre enn panelene (kapping) */
  clippedKwh: number;
  peakKw: number;
  peakAt: string;
  /** Timer der uttaket fra nettet er over importgrensen */
  overImportLimitHours: number;
  battery?: BatteryMonth;
  cost: {
    kraft: number;
    kraftGebyr: number;
    fastledd: number;
    energiledd: number;
    effektledd: number;
    elavgift: number;
    salg: number; // inntekt (positiv)
    netto: number; // sum kostnader − salg
  };
}

export interface EngineResult {
  months: MonthResult[];
  total: Omit<MonthResult, "month" | "peakAt" | "days" | "peakKw"> & { days: number };
  checks: { maxBalanceErrorKwh: number; intervals: number; batteryBalanceErrorKwh?: number; endSocKwh?: number; startSocKwh?: number };
  /** Timeverdier for batteriet (for døgnutsnitt). Bare når batteri er med. */
  /** Per intervall (time eller kvarter): batterinivå (kWh), batterieffekt (kW, + utlading), pris, forbruk og sol (kWh) */
  hourly?: { startUtc: number; stepMin: number; soc: Float64Array; battery: Float64Array; price: Float32Array; load: Float32Array; pv: Float32Array };
}

/** Gjeldende satser på en lokal dato, inkludert satsendringer midt i året. */
export function rateAt(t: Tariff, d: { year: number; month: number; day: number }) {
  const z = (x: number) => String(x).padStart(2, "0");
  const iso = `${d.year}-${z(d.month)}-${z(d.day)}`;
  const r = {
    energyOrePerKwh: t.energyOrePerKwh,
    summerNokPerKwMonth: t.power?.summerNokPerKwMonth ?? 0,
    winterNokPerKwMonth: t.power?.winterNokPerKwMonth ?? 0,
  };
  for (const c of [...(t.rateChanges ?? [])].sort((a, b) => a.from.localeCompare(b.from)))
    if (c.from <= iso) {
      if (c.energyOrePerKwh != null) r.energyOrePerKwh = c.energyOrePerKwh;
      if (c.summerNokPerKwMonth != null) r.summerNokPerKwMonth = c.summerNokPerKwMonth;
      if (c.winterNokPerKwMonth != null) r.winterNokPerKwMonth = c.winterNokPerKwMonth;
    }
  return r;
}

/** Elavgift for timen: periodens sats, ellers fast sats. */
function elRate(taxes: Taxes, d: { year: number; month: number; day: number }) {
  if (!taxes.periods?.length) return taxes.elavgiftOrePerKwh;
  const z = (x: number) => String(x).padStart(2, "0");
  const iso = `${d.year}-${z(d.month)}-${z(d.day)}`;
  for (const p of taxes.periods) if (p.from <= iso && iso <= p.to) return p.orePerKwh;
  return taxes.elavgiftOrePerKwh;
}

function at(s: TimeSeries, t: number): number {
  const i = (t - s.startUtc) / (s.resolutionMin * 60_000);
  return Number.isInteger(i) && i >= 0 && i < s.values.length ? s.values[i] : NaN;
}

/**
 * Verdi for intervallet [t, t+step) uansett seriens oppløsning.
 * Energi (kWh): time → kvarter deles likt på fire (antakelse), kvarter → time summeres.
 * Pris: time → kvarter gjentas, kvarter → time snittes.
 */
export function valueAt(s: TimeSeries, t: number, stepMs: number, energy: boolean): number {
  const res = s.resolutionMin * 60_000;
  if (res === stepMs) return at(s, t);
  if (res > stepMs) {
    const start = t - ((((t - s.startUtc) % res) + res) % res);
    const v = at(s, start);
    return energy ? (v * stepMs) / res : v;
  }
  const k = stepMs / res;
  let sum = 0;
  for (let j = 0; j < k; j++) sum += at(s, t + j * res);
  return energy ? sum : sum / k;
}

/** Fordeling av én time gitt batteriets AC-effekt b (+ utlading, − lading). Ren regel, brukes av styring og regnskap. */
export interface HourFlow {
  direct: number;
  battToLoad: number;
  battToGrid: number;
  pvToBatt: number;
  gridToBatt: number;
  gridToLoad: number;
  pvExport: number;
  curtailed: number;
  imp: number;
  exp: number;
  /** Faktisk batterieffekt etter eksportgrensen (kan bli redusert) */
  b: number;
}

export function hourFlow(L: number, P: number, b: number, exportLimit: number, curtailPv: boolean): HourFlow {
  const net = L - P;
  const direct = Math.min(L, P);
  let battToLoad = 0, battToGrid = 0, pvToBatt = 0, gridToBatt = 0;
  let surplus = Math.max(-net, 0);
  const deficit = Math.max(net, 0);
  if (b >= 0) {
    battToLoad = Math.min(b, deficit);
    battToGrid = b - battToLoad;
  } else {
    pvToBatt = Math.min(-b, surplus);
    gridToBatt = -b - pvToBatt;
    surplus -= pvToBatt;
  }
  const gridToLoad = deficit - battToLoad;
  let pvExport = curtailPv ? 0 : surplus;
  // Eksportgrensen gjelder samlet salg: sol kappes først, deretter batteriets salg
  if (pvExport + battToGrid > exportLimit) {
    pvExport = Math.max(0, Math.min(pvExport, exportLimit - battToGrid));
    if (battToGrid > exportLimit) battToGrid = exportLimit;
  }
  const curtailed = surplus - pvExport;
  const bOut = b >= 0 ? battToLoad + battToGrid : b;
  return { direct, battToLoad, battToGrid, pvToBatt, gridToBatt, gridToLoad, pvExport, curtailed, imp: gridToLoad + gridToBatt, exp: pvExport + battToGrid, b: bOut };
}

export function simulate(inp: EngineInput): EngineResult {
  const { load, pv, spot, buy, sell, tariff, taxes } = inp;
  // Oppløsningen følger forbruksserien: time eller kvarter. Andre serier tilpasses (se valueAt).
  const stepMin = inp.stepMin ?? load.resolutionMin;
  if (stepMin !== 60 && stepMin !== 15) throw new Error("Motoren regner per time eller kvarter.");
  const STEP = stepMin * 60_000;
  const stepH = stepMin / 60;
  const from = inp.fromUtc ?? load.startUtc;
  const to = inp.toUtc ?? load.startUtc + load.values.length * load.resolutionMin * 60_000;
  const n = Math.round((to - from) / STEP);
  const pvF = inp.pvFactor ?? 1;
  const expLim = inp.exportLimitKw == null ? Infinity : inp.exportLimitKw * stepH; // kWh per intervall
  const impLim = inp.importLimitKw == null || inp.importLimitKw <= 0 ? Infinity : inp.importLimitKw * stepH;
  const acKwh = inp.inverterAcKw == null || inp.inverterAcKw <= 0 ? Infinity : inp.inverterAcKw * stepH;
  const bat = inp.battery ?? null;
  const aux = bat ? Math.max(0, bat.auxKw) * stepH : 0;
  const sharedAc = bat?.sharedAcKw != null && bat.sharedAcKw > 0 ? bat.sharedAcKw * stepH : Infinity;
  const chargeE = bat ? bat.chargeKw * stepH : 0;
  const dischargeE = bat ? bat.dischargeKw * stepH : 0;
  // Effektleddet måles per time (vanligst) eller per kvarter, etter tariffen
  const peakPerQuarter = tariff.power?.resolution === "kvarter" && stepMin === 15;
  const buyPrice = (s: number) => (buy.type === "fastpris" && buy.fixedOrePerKwh != null ? buy.fixedOrePerKwh / 100 : s + buy.markupOrePerKwh / 100);
  const sellPrice = (s: number) => {
    const p = sell.type === "fastpris" && sell.fixedOrePerKwh != null ? sell.fixedOrePerKwh / 100 : s - sell.deductionOrePerKwh / 100;
    return sell.floorOrePerKwh != null ? Math.max(p, sell.floorOrePerKwh / 100) : p;
  };

  // ---- forhåndsberegn timeverdier
  const L = new Float64Array(n), P = new Float64Array(n), clip = new Float64Array(n), S = new Float64Array(n);
  const buyNok = new Float64Array(n), sellNok = new Float64Array(n), energyNok = new Float64Array(n), elNok = new Float64Array(n);
  const win = new Uint8Array(n), monthIdx = new Int32Array(n), hourOfDay = new Int8Array(n), minuteOf = new Int8Array(n);
  const peakRate = new Float64Array(n);
  const monthKeys: string[] = [];
  const monthDays: Set<number>[] = [];
  const holidaysByYear = new Map<number, Set<string>>();
  const z = (x: number) => String(x).padStart(2, "0");
  for (let i = 0; i < n; i++) {
    const t = from + i * STEP;
    const l = valueAt(load, t, STEP, true);
    const praw = pv ? valueAt(pv, t, STEP, true) * pvF : 0;
    const s = valueAt(spot, t, STEP, false);
    if (!Number.isFinite(l)) throw new Error(`Forbruk mangler ${fmtLocal(t)} – beregnes ikke (ingen stille nullverdier).`);
    if (!Number.isFinite(praw)) throw new Error(`Produksjon mangler ${fmtLocal(t)}.`);
    if (!Number.isFinite(s)) throw new Error(`Spotpris mangler ${fmtLocal(t)}.`);
    const p = Math.min(praw, acKwh);
    L[i] = l;
    P[i] = p;
    clip[i] = praw - p;
    S[i] = s;
    const lp = osloParts(t);
    hourOfDay[i] = lp.hour;
    minuteOf[i] = lp.minute;
    const key = `${lp.year}-${z(lp.month)}`;
    let mi = monthKeys.indexOf(key);
    if (mi < 0) {
      mi = monthKeys.push(key) - 1;
      monthDays.push(new Set());
    }
    monthIdx[i] = mi;
    monthDays[mi].add(lp.day);
    const r = rateAt(tariff, lp);
    energyNok[i] = r.energyOrePerKwh / 100;
    elNok[i] = elRate(taxes, lp) / 100;
    buyNok[i] = buyPrice(s) + energyNok[i] + elNok[i];
    sellNok[i] = sellPrice(s);
    const pw = tariff.power;
    if (pw) {
      let hol = holidaysByYear.get(lp.year);
      if (!hol) holidaysByYear.set(lp.year, (hol = norwegianHolidays(lp.year)));
      win[i] =
        pw.window.weekdays.includes(lp.weekday) &&
        lp.hour >= pw.window.fromHour &&
        lp.hour < pw.window.toHour &&
        !(pw.window.excludeHolidays && hol.has(`${lp.year}-${z(lp.month)}-${z(lp.day)}`))
          ? 1
          : 0;
      peakRate[i] = pw.summerMonths.includes(lp.month) ? r.summerNokPerKwMonth : r.winterNokPerKwMonth;
    }
  }

  // ---- måneder
  const months: MonthResult[] = monthKeys.map((key) => ({
    month: key, days: 0, loadKwh: 0, pvKwh: 0, selfKwh: 0, importKwh: 0, exportKwh: 0, curtailedKwh: 0, clippedKwh: 0, peakKw: 0, peakAt: "", overImportLimitHours: 0,
    ...(bat
      ? { battery: { chargeKwh: 0, solarChargeKwh: 0, gridChargeKwh: 0, dischargeKwh: 0, toLoadKwh: 0, toGridKwh: 0, lossKwh: 0, auxKwh: 0, gridChargeCostNok: 0, toGridRevenueNok: 0, cycles: 0 } }
      : {}),
    cost: { kraft: 0, kraftGebyr: 0, fastledd: 0, energiledd: 0, effektledd: 0, elavgift: 0, salg: 0, netto: 0 },
  }));

  // ---- batteri: tilstand
  const capF = bat ? Math.max(0, Math.min(1, bat.capacityFactor ?? 1)) : 0;
  const eMax = bat ? bat.usableKwh * capF : 0;
  const eMin = bat ? Math.min(eMax, eMax * Math.max(0, Math.min(1, bat.reserveShare))) : 0;
  const etaC = bat ? Math.sqrt(Math.max(0.5, Math.min(1, bat.roundTrip))) : 1;
  const etaD = etaC;
  let soc = eMin;
  let socSol = 0; // solandelen av energien over reservenivået (for egenbruk-regnskapet)
  const startSoc = soc;
  let plan: { b: Float64Array; grid: Float64Array; mv: Float64Array; imp: Float64Array } | null = null;
  let planStart = 0;
  const hourly = bat
    ? { startUtc: from, stepMin, soc: new Float64Array(n), battery: new Float64Array(n), price: new Float32Array(n), load: new Float32Array(n), pv: new Float32Array(n) }
    : undefined;
  let socIn = 0, socOut = 0;

  let maxErr = 0;
  let hourImp = 0; // import i inneværende time (for effektledd målt per time ved kvartersoppløsning)
  for (let i = 0; i < n; i++) {
    const m = months[monthIdx[i]];
    const Li = L[i] + aux;
    const Pi = P[i];
    let b = 0;
    const curtail = !!bat && bat.strategy === "smart" && sellNok[i] < 0; // smartstyring selger ikke sol til negativ pris

    if (bat && eMax > 0) {
      const net = Li - Pi;
      const maxC = Math.min(chargeE, (eMax - soc) / etaC);
      // Delt hybridinverter: sol og batteriutlading deler inverterens AC-effekt
      const maxD = Math.min(dischargeE, (soc - eMin) * etaD, Math.max(0, sharedAc - Pi));
      if (bat.strategy === "grunn") {
        // Grunnstyring: lader av overskudd fra sol, dekker eget forbruk. Ingen nettlading eller salg fra batteriet.
        if (net < 0) b = -Math.min(-net, Math.max(0, maxC), sharedAc);
        else b = Math.min(net, Math.max(0, maxD));
      } else {
        // Smartstyring: ny plan kl. 13 hver dag (da morgendagens priser er kjent) og ved start
        if (i === 0 || (hourOfDay[i] === 13 && minuteOf[i] === 0)) {
          plan = planHorizon(
            {
              n, i0: i, L, P, aux, buyNok, sellNok, win, peakRate, monthIdx, hourOfDay, minuteOf, stepH,
              curPeak: m.peakKw, eMin, eMax, etaC, etaD, expLim, impLim, sharedAc,
            },
            bat,
            soc,
          );
          planStart = i;
        }
        const want = plan ? (plan.b[i - planStart] ?? 0) : 0;
        const plannedGrid = plan ? (plan.grid[i - planStart] ?? 0) : 0;
        // Verdien av lagret energi ifølge planen (kr per kWh DC)
        const mv = plan ? (plan.mv[i - planStart] ?? 0) : 0;
        b = want;
        // Gjennomfør planen så langt det faktisk går med virkelig forbruk og sol
        if (b < 0) {
          let c = Math.min(-b, Math.max(0, maxC));
          // Lading som var ment å komme fra sol, hentes ikke fra nettet når solen svikter
          c = Math.min(c, Math.max(0, -net) + plannedGrid);
          if (!bat.gridCharge) c = Math.min(c, Math.max(0, -net));
          // Lading fra nett går gjennom inverteren
          c = Math.min(c, Math.max(0, -net) + sharedAc);
          // Ikke lad over importgrensen
          const impNoCharge = Math.max(net, 0);
          const room = impLim - impNoCharge + Math.max(0, -net);
          c = Math.min(c, Math.max(0, room));
          b = -c;
        }
        // Avvik fra prognosen: uventet overskudd lagres, og uventet underskudd dekkes, når det lønner seg
        // etter planens verdi av lagret energi (samme vurdering som planen ville gjort).
        if (b <= 0 && net < 0) {
          const extra = Math.min(-net - Math.max(0, -b), Math.max(0, maxC) + b, sharedAc);
          if (extra > 1e-9 && Math.max(sellNok[i], 0) < mv * etaC) b -= extra;
        } else if (b >= 0 && net > 0 && !(win[i] && peakRate[i] > 0)) {
          // (I effektvinduet styres utladingen av planen og effektstyringen under, så energi spart til toppen ikke brukes opp.)
          const extra = Math.min(net - b, Math.max(0, maxD) - b);
          if (extra > 1e-9 && buyNok[i] > mv / etaD + bat.wearNokPerKwh) b += extra;
        }
        // Sanntids effektvakt: blir importen høyere enn planen regnet med og over månedens topp så langt,
        // lades det ut for å holde toppen (styringen måler effekten løpende – ingen fasit brukes).
        if (win[i] && peakRate[i] > 0) {
          const expected = plan ? (plan.imp[i - planStart] ?? 0) : 0;
          const cap = Math.max(m.peakKw * stepH, expected);
          const imp = net - b;
          if (imp > cap + 1e-9) {
            const add = imp - cap;
            b = b < 0 ? Math.min(0, b + add) : b; // dropp først planlagt lading
            const still = net - b - cap;
            if (still > 1e-9) b = Math.min(b + still, Math.max(0, maxD));
          }
        }
        if (b > 0) {
          let d = Math.min(b, Math.max(0, maxD));
          if (!bat.gridExport) d = Math.min(d, Math.max(0, net));
          b = d;
        }
      }
    }

    const f = hourFlow(Li, Pi, b, expLim, curtail);
    b = f.b;
    // Batteriets tilstand
    if (bat && eMax > 0) {
      const before = soc;
      if (b < 0) {
        const inDc = -b * etaC;
        soc += inDc;
        socIn += inDc;
        // Solandel av ny energi
        socSol += f.pvToBatt * etaC;
      } else if (b > 0) {
        const outDc = b / etaD;
        const above = Math.max(1e-12, before - eMin);
        const solShare = Math.min(1, socSol / above);
        socSol = Math.max(0, socSol - outDc * solShare);
        soc -= outDc;
        socOut += outDc;
        // Bare solandelen av batteriets strøm til bygget regnes som egenbruk av sol
        m.selfKwh += f.battToLoad * solShare;
      }
      if (soc > eMax + 1e-9 || soc < eMin - 1e-9) throw new Error(`Batterinivå utenfor grensene ${fmtLocal(from + i * STEP)}.`);
      soc = Math.min(eMax, Math.max(eMin, soc));
      socSol = Math.min(socSol, soc - eMin);
      const bm = m.battery!;
      bm.chargeKwh += f.pvToBatt + f.gridToBatt;
      bm.solarChargeKwh += f.pvToBatt;
      bm.gridChargeKwh += f.gridToBatt;
      bm.dischargeKwh += f.battToLoad + f.battToGrid;
      bm.toLoadKwh += f.battToLoad;
      bm.toGridKwh += f.battToGrid;
      bm.auxKwh += aux;
      bm.gridChargeCostNok += f.gridToBatt * buyNok[i];
      bm.toGridRevenueNok += f.battToGrid * sellNok[i];
      bm.cycles += b > 0 && bat.usableKwh > 0 ? b / etaD / (bat.usableKwh * capF || 1) : 0;
      hourly!.soc[i] = soc;
      hourly!.battery[i] = b / stepH; // kW
      hourly!.price[i] = S[i];
      hourly!.load[i] = L[i];
      hourly!.pv[i] = Pi;
    }

    // Kontroll: forbruk og sol går opp i hver time
    maxErr = Math.max(
      maxErr,
      Math.abs(Li - f.direct - f.battToLoad - f.gridToLoad),
      Math.abs(Pi - f.direct - f.pvToBatt - f.pvExport - f.curtailed),
    );

    m.loadKwh += L[i];
    m.pvKwh += Pi;
    m.selfKwh += f.direct;
    m.importKwh += f.imp;
    m.exportKwh += f.exp;
    m.curtailedKwh += f.curtailed;
    m.clippedKwh += clip[i];
    if (f.imp > impLim + 1e-9) m.overImportLimitHours++;
    m.cost.kraft += f.imp * buyPrice(S[i]);
    m.cost.energiledd += f.imp * energyNok[i];
    m.cost.elavgift += f.imp * elNok[i];
    m.cost.salg += f.exp * sellNok[i];
    if (win[i]) {
      if (stepMin === 60 || peakPerQuarter) {
        const kw = f.imp / stepH;
        if (kw > m.peakKw) {
          m.peakKw = kw;
          m.peakAt = fmtLocal(from + i * STEP);
        }
      } else {
        // Kvartersdata, effekt målt per time: summer timen
        hourImp += f.imp;
        if (minuteOf[i] === 45 || i === n - 1) {
          if (hourImp > m.peakKw) {
            m.peakKw = hourImp;
            m.peakAt = fmtLocal(from + (i - 3) * STEP);
          }
          hourImp = 0;
        }
      }
    } else hourImp = 0;
  }

  // Sluttbeholdning: batteriet skal ende på samme nivå som det startet (reservenivået).
  // Er det energi igjen, verdsettes den til siste times kjøpspris (redusert kostnad) – sjelden og liten.
  let batteryBalanceErr: number | undefined;
  if (bat && eMax > 0) {
    const leftover = soc - startSoc;
    if (leftover > 1e-6 && n > 0) {
      const last = months[monthIdx[n - 1]];
      last.cost.kraft -= leftover * etaD * buyPrice(S[n - 1]);
    }
    batteryBalanceErr = Math.abs(startSoc + socIn - socOut - soc);
    for (const m of months)
      if (m.battery) m.battery.lossKwh = 0;
    // Tap per måned: inn (AC) − ut (AC) − endring i lagret energi, fordelt via timeserien
    let prev = startSoc;
    for (let i = 0; i < n; i++) {
      const bm = months[monthIdx[i]].battery!;
      const b = hourly!.battery[i] * stepH;
      const ds = hourly!.soc[i] - prev;
      prev = hourly!.soc[i];
      bm.lossKwh += (b < 0 ? -b : 0) - (b > 0 ? b : 0) - ds;
    }
  }

  const yearDays = new Map<number, number>();
  for (let k = 0; k < months.length; k++) {
    const m = months[k];
    const y = +m.month.slice(0, 4);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    yearDays.set(y, leap ? 366 : 365);
    m.days = monthDays[k].size;
    const fullMonthDays = new Date(Date.UTC(y, +m.month.slice(5), 0)).getUTCDate();
    m.cost.fastledd =
      tariff.fixedAllocation === "per_dag"
        ? (tariff.fixedNokPerYear / yearDays.get(y)!) * m.days
        : (tariff.fixedNokPerYear / 12) * (m.days / fullMonthDays);
    m.cost.kraftGebyr = buy.monthlyFeeNok * (m.days / fullMonthDays);
    if (tariff.power) {
      const mon = +m.month.slice(5);
      const r = rateAt(tariff, { year: y, month: mon, day: 1 });
      const rate = tariff.power.summerMonths.includes(mon) ? r.summerNokPerKwMonth : r.winterNokPerKwMonth;
      // Delmåned (hittil i år): effektledd tas med for påbegynt måned slik nettselskapet fakturerer
      m.cost.effektledd = m.peakKw * rate;
    }
    const c = m.cost;
    c.netto = c.kraft + c.kraftGebyr + c.fastledd + c.energiledd + c.effektledd + c.elavgift - c.salg;
  }

  const list = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const total = list.reduce(
    (acc, m) => {
      for (const k of ["loadKwh", "pvKwh", "selfKwh", "importKwh", "exportKwh", "curtailedKwh", "clippedKwh", "days", "overImportLimitHours"] as const) acc[k] += m[k];
      for (const k of Object.keys(acc.cost) as (keyof MonthResult["cost"])[]) acc.cost[k] += m.cost[k];
      if (m.battery) {
        acc.battery ??= { chargeKwh: 0, solarChargeKwh: 0, gridChargeKwh: 0, dischargeKwh: 0, toLoadKwh: 0, toGridKwh: 0, lossKwh: 0, auxKwh: 0, gridChargeCostNok: 0, toGridRevenueNok: 0, cycles: 0 };
        for (const k of Object.keys(m.battery) as (keyof BatteryMonth)[]) acc.battery[k] += m.battery[k];
      }
      return acc;
    },
    {
      days: 0, loadKwh: 0, pvKwh: 0, selfKwh: 0, importKwh: 0, exportKwh: 0, curtailedKwh: 0, clippedKwh: 0, overImportLimitHours: 0,
      cost: { kraft: 0, kraftGebyr: 0, fastledd: 0, energiledd: 0, effektledd: 0, elavgift: 0, salg: 0, netto: 0 },
    } as EngineResult["total"],
  );
  return {
    months: list,
    total,
    checks: { maxBalanceErrorKwh: maxErr, intervals: n, ...(bat ? { batteryBalanceErrorKwh: batteryBalanceErr, startSocKwh: startSoc, endSocKwh: soc } : {}) },
    hourly,
  };
}

/** Besparelse per komponent: før − etter (positivt = kunden sparer). */
export function savings(before: EngineResult, after: EngineResult) {
  const b = before.total.cost;
  const a = after.total.cost;
  return {
    kraft: b.kraft - a.kraft,
    nettleieEnergi: b.energiledd - a.energiledd,
    effektledd: b.effektledd - a.effektledd,
    elavgift: b.elavgift - a.elavgift,
    fastOgGebyr: b.fastledd + b.kraftGebyr - (a.fastledd + a.kraftGebyr), // skal være 0
    salg: a.salg - b.salg,
    total: b.netto - a.netto,
  };
}
