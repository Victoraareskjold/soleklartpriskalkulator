// Batteristyring for næringsanalysen.
//
// To styringsmåter (samme batteri, samme begrensninger):
//  • grunn: lader av overskudd fra sol og dekker eget forbruk. Ingen nettlading, ikke salg fra batteriet.
//    (Regnes direkte i engine.ts, time for time.)
//  • smart: legger en plan hver dag kl. 13, når morgendagens spotpriser er publisert, for resten av i dag og
//    hele i morgen (dynamisk programmering over batterinivå og månedens effekttopp). Planen bruker bare det
//    styringen kunne visst: kjente spotpriser og tariff, og en enkel prognose for forbruk og sol
//    (persistens: samme time dagen før, eller to dager før hvis den ikke har skjedd ennå).
//    Planen gjennomføres med virkelig forbruk og sol; det som ikke lar seg gjennomføre, kappes.
//    Med prognose «perfekt» brukes fasiten – bare som referanse, ikke som påstand om hva en
//    bestemt inverter oppnår.
//
// Kostnaden i planen = kjøp (spot + påslag + energiledd + elavgift) − salg + økt effektledd
//   + slitasjekostnad per kWh utladet (bare i styringen; den føres ikke som kontantutbetaling).
// Ved slutten av planperioden verdsettes lagret energi til et forsiktig anslag (90 % av snittet av
// kjøpsprisene i perioden × virkningsgrad ut). I siste plan har lagret energi ingen verdi.

export interface BatteryConfig {
  /** Brukbar kapasitet i kWh (nominell × brukbar andel) som ny */
  usableKwh: number;
  /** Aldring: andel av brukbar kapasitet som er igjen (1 = ny) */
  capacityFactor?: number;
  /** Andel av brukbar kapasitet holdt igjen som nødstrømsreserve (0–1) */
  reserveShare: number;
  chargeKw: number;
  dischargeKw: number;
  /** Hybridinverterens AC-effekt som sol og batteri deler (kW). null = ikke delt / ukjent */
  sharedAcKw?: number | null;
  /** Tur-retur-virkningsgrad (0–1), fordeles likt på lading og utlading */
  roundTrip: number;
  /** Hjelpelast (styring, kjøling) i kW, hele tiden */
  auxKw: number;
  /** Tillatt å lade fra nettet */
  gridCharge: boolean;
  /** Tillatt å selge fra batteriet til nettet */
  gridExport: boolean;
  strategy: "grunn" | "smart";
  forecast: "persistens" | "perfekt";
  /** Slitasjekostnad brukt i styringen (kr per kWh utladet). Ikke en kontantutgift. */
  wearNokPerKwh: number;
}

export interface PlanContext {
  n: number;
  i0: number;
  L: Float64Array;
  /** Planlagt lading til kjøretøy (del av L). Er en kjent timeplan, så styringen bruker den som den er – ikke prognosen. */
  C?: Float64Array;
  P: Float64Array;
  aux: number;
  buyNok: Float64Array;
  sellNok: Float64Array;
  win: Uint8Array;
  peakRate: Float64Array;
  monthIdx: Int32Array;
  hourOfDay: Int8Array;
  minuteOf: Int8Array;
  /** Intervallets lengde i timer (1 eller 0,25) */
  stepH: number;
  /** Delt inverterkapasitet per intervall (kWh), Infinity = ikke delt */
  sharedAc: number;
  /** Månedens høyeste time i effektvinduet så langt (gjennomført) */
  curPeak: number;
  eMin: number;
  eMax: number;
  etaC: number;
  etaD: number;
  expLim: number;
  impLim: number;
}

/** Slutten av planperioden: første midnatt minst 12 timer etter planleggingstidspunktet. */
function horizonEnd(c: PlanContext) {
  let k = c.i0 + Math.round(12 / c.stepH);
  while (k < c.n && !(c.hourOfDay[k] === 0 && c.minuteOf[k] === 0)) k++;
  return Math.min(k, c.n);
}

/** Intervallet prognosen henter verdier fra: samme tid ett eller flere døgn før planleggingstidspunktet (persistens). */
function forecastIndex(c: PlanContext, t: number, perfect: boolean) {
  if (perfect) return t;
  const day = Math.round(24 / c.stepH);
  let s = t - day;
  while (s >= c.i0) s -= day;
  return s < 0 ? t : s; // ingen historikk ved starten av perioden: bruk faktisk verdi (merket i dokumentasjonen)
}

/**
 * Optimal plan (AC-effekt per time, + utlading / − lading) fra i0 til slutten av planperioden.
 * Tilstand: batterinivå (diskret) × nivå på månedens nye effekttopp (diskret).
 */
export interface Plan {
  /** Planlagt AC-effekt per intervall (energi, + utlading / − lading) */
  b: Float64Array;
  /** Hvor mye av planlagt lading som er ment å komme fra nettet (resten fra forventet overskudd fra sol) */
  grid: Float64Array;
  /** Verdien av én kWh lagret energi (DC) etter intervallet, fra planen (kr/kWh). Brukes til avvik fra planen. */
  mv: Float64Array;
  /** Forventet import fra nettet per intervall etter planen (kWh) */
  imp: Float64Array;
}

export function planHorizon(c: PlanContext, bat: BatteryConfig, soc0: number): Plan {
  const end = horizonEnd(c);
  const H = end - c.i0;
  const out = new Float64Array(Math.max(0, H));
  const grid = new Float64Array(Math.max(0, H));
  const mv = new Float64Array(Math.max(0, H));
  const impP = new Float64Array(Math.max(0, H));
  if (H <= 0 || c.eMax - c.eMin < 1e-6) return { b: out, grid, mv, imp: impP };
  const perfect = bat.forecast === "perfekt";
  const range = c.eMax - c.eMin;

  // Diskretisering av batterinivået: høyst ~80 trinn, minst 4 trinn per times maksimale lading/utlading
  const maxStepEnergy = Math.max(1e-6, Math.min(bat.chargeKw * c.stepH * c.etaC, (bat.dischargeKw * c.stepH) / c.etaD));
  let step = maxStepEnergy / 4;
  if (range / step > 80) step = range / 80;
  const N = Math.max(1, Math.round(range / step)) + 1;
  step = range / (N - 1);
  const Kc = Math.max(0, Math.floor((bat.chargeKw * c.stepH * c.etaC) / step + 1e-9));
  const Kd = Math.max(0, Math.floor((bat.dischargeKw * c.stepH) / c.etaD / step + 1e-9));
  const i0soc = Math.max(0, Math.min(N - 1, Math.round((soc0 - c.eMin) / step)));

  // Prognose og priser for perioden
  const fn = new Float64Array(H);
  const fp = new Float64Array(H);
  let buySum = 0;
  for (let h = 0; h < H; h++) {
    const s = forecastIndex(c, c.i0 + h, perfect);
    const known = c.C ? c.C[c.i0 + h] - c.C[s] : 0;
    fn[h] = c.L[s] + known + c.aux - c.P[s];
    fp[h] = c.P[s];
    buySum += c.buyNok[c.i0 + h];
  }
  // Siste plan i perioden: lagret energi har ingen verdi i planen (gjenværende energi verdsettes i motoren)
  // Lagret energi er verdt det den kan spare senere, minus slitasjen ved utladingen
  const vTerm = end >= c.n ? 0 : Math.max(0, 0.9 * (buySum / H) - bat.wearNokPerKwh) * c.etaD;

  // Effekttopp-nivåer per måned i perioden
  const hasPower = c.win.subarray(c.i0, end).some((x) => x === 1);
  const M = hasPower ? 8 : 1;
  const firstMonth = c.monthIdx[c.i0];
  const ref = new Float64Array(H); // gjennomført topp ved start av måneden i perioden
  const delta = new Float64Array(H);
  if (hasPower) {
    // Største mulige import i vinduet per månedssegment
    const segMax = new Map<number, number>();
    for (let h = 0; h < H; h++) {
      const t = c.i0 + h;
      if (!c.win[t]) continue;
      const mx = (Math.max(0, fn[h]) + (bat.gridCharge ? bat.chargeKw * c.stepH : 0)) / c.stepH; // kW
      segMax.set(c.monthIdx[t], Math.max(segMax.get(c.monthIdx[t]) ?? 0, mx));
    }
    for (let h = 0; h < H; h++) {
      const mi = c.monthIdx[c.i0 + h];
      const r = mi === firstMonth ? c.curPeak : 0;
      ref[h] = r;
      const top = segMax.get(mi) ?? r;
      delta[h] = top > r ? (top - r) / (M - 1) : 0;
    }
  }

  const S = N * M;
  let V = new Float64Array(S);
  let Vn = new Float64Array(S);
  const Vall = new Float64Array((H + 1) * S); // V for hvert tidspunkt (for verdien av lagret energi)
  const policy = new Int32Array(H * S); // neste tilstand (j * M + m')

  // Sluttverdi
  for (let j = 0; j < N; j++)
    for (let m = 0; m < M; m++) V[j * M + m] = -(j * step) * vTerm;

  Vall.set(V, H * S);
  for (let h = H - 1; h >= 0; h--) {
    const t = c.i0 + h;
    const net = fn[h];
    const buy = c.buyNok[t];
    const sell = c.sellNok[t];
    const curtailPv = sell < 0;
    const inWin = hasPower && c.win[t] === 1;
    const rate = c.peakRate[t];
    const monthStarts = h > 0 && c.monthIdx[t] !== c.monthIdx[t - 1];
    const d = delta[h];
    const r = ref[h];
    for (let i = 0; i < N; i++) {
      const jLo = Math.max(0, i - Kd);
      const jHi = Math.min(N - 1, i + Kc);
      for (let m0 = 0; m0 < M; m0++) {
        // Ved månedsskifte starter toppen på nytt (ny måned, ingen gjennomført topp)
        const m = monthStarts ? 0 : m0;
        const level = r + m * d;
        let best = Infinity;
        let bestS = i * M + m;
        for (let j = jLo; j <= jHi; j++) {
          const dE = (j - i) * step;
          const b = dE > 0 ? -dE / c.etaC : -dE * c.etaD; // AC: + utlading
          // Begrensninger
          if (b < 0 && !bat.gridCharge && -b > Math.max(0, -net) + 1e-9) continue;
          if (b > 0 && !bat.gridExport && b > Math.max(0, net) + 1e-9) continue;
          // Delt hybridinverter: utlading og sol deler AC-effekten, lading fra nett går gjennom den
          if (b > 0 && b > Math.max(0, c.sharedAc - fp[h]) + 1e-9) continue;
          if (b < 0 && -b - Math.max(0, -net) > c.sharedAc + 1e-9) continue;
          const g = net - b;
          const imp = g > 0 ? g : 0;
          if (b < 0 && imp > c.impLim + 1e-9) continue;
          let exp = g < 0 ? -g : 0;
          const battExp = b > 0 ? Math.max(0, b - Math.max(0, net)) : 0;
          if (battExp > c.expLim + 1e-9) continue;
          const pvExp = curtailPv ? 0 : Math.min(exp - battExp, Math.max(0, c.expLim - battExp));
          exp = pvExp + battExp;
          let cost = imp * buy - exp * sell + (b > 0 ? b * bat.wearNokPerKwh : 0);
          let m2 = m;
          const kw = imp / c.stepH;
          if (inWin && d > 0 && kw > level + 1e-9) {
            m2 = Math.min(M - 1, Math.ceil((kw - r) / d - 1e-9));
            cost += rate * (r + m2 * d - level);
          }
          const tot = cost + V[j * M + m2];
          if (tot < best) {
            best = tot;
            bestS = j * M + m2;
          }
        }
        Vn[i * M + m0] = best;
        policy[h * S + i * M + m0] = bestS;
      }
    }
    const tmp = V;
    V = Vn;
    Vn = tmp;
    Vall.set(V, h * S);
  }

  // Fremover: plan fra dagens nivå og gjennomført topp
  let s = i0soc * M + 0;
  for (let h = 0; h < H; h++) {
    const nx = policy[h * S + s];
    const i = Math.floor(s / M);
    const j = Math.floor(nx / M);
    const dE = (j - i) * step;
    out[h] = dE > 0 ? -dE / c.etaC : -dE * c.etaD;
    grid[h] = out[h] < 0 ? Math.max(0, -out[h] - Math.max(0, -fn[h])) : 0;
    impP[h] = Math.max(0, fn[h] - out[h]);
    // Marginalverdi av lagret energi etter intervallet: endring i fremtidig kostnad per kWh
    const m2 = nx % M;
    const off = (h + 1) * S;
    const lo = Math.max(0, j - 1), hi = Math.min(N - 1, j + 1);
    const vLo = Vall[off + lo * M + m2], vHi = Vall[off + hi * M + m2];
    mv[h] = hi > lo && Number.isFinite(vLo) && Number.isFinite(vHi) ? Math.max(0, (vLo - vHi) / ((hi - lo) * step)) : 0;
    s = nx;
  }
  return { b: out, grid, mv, imp: impP };
}
