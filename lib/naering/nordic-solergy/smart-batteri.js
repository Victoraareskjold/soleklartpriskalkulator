/*
 * smart-batteri.js
 * Smart batteristyring og lønnsomhet, time for time over ett år (8760 timer).
 * Nordic Solergy AS, 2026. Se SMART-BATTERI-BESKRIVELSE.md for hvordan det regner og hvorfor.
 *
 * Ren JavaScript uten avhengigheter. Virker i nettleseren (global SmartBatteri) og i Node (require).
 *
 * Rutenettet: indeks i = 0 … 8759, der 0 er 1. januar kl. 00–01. 29. februar er ikke med.
 * Energi per time i kWh er det samme som snitteffekt i kW den timen.
 * Priser i kroner per kWh, unntatt der det står øre.
 *
 * Bruk, kort:
 *   const SB = require('./smart-batteri.js');
 *   const forbruk = SB.forbrukTil8760(maalinger).timer;            // [{ ts, kwh }] fra måledata
 *   const sol     = SB.sommertid(solNormaltid.slice(), 2025);      // valgfritt
 *   const nett    = SB.nettTimer(tariff, 1.25, 2025, 7.13 + 1);    // energiledd + elavgift (+ Enova privat)
 *   const p       = SB.prisserier({ spot, nett, mvaF: 1.25, paaslagOre: 5, avtale: 'spot' });
 *   const r       = SB.simuler({ forbruk, sol, kjop: p.kjop, salg: p.salg, kapKwh: 20, kw: 10,
 *                                tariff, mvaF: 1.25, smart: true });
 *   r.okonomi.gevinst  → gevinst år 1 i kroner (mot ingen sol og intet batteri)
 */
(function (rot, fabrikk) {
  if (typeof module === 'object' && module.exports) module.exports = fabrikk();
  else rot.SmartBatteri = fabrikk();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Innstillinger ──────────────────────────────────────────────
  // Kan endres før bruk: SmartBatteri.INNSTILLINGER.margin = 0.10 osv.
  const INNSTILLINGER = {
    virkningsgrad: 0.95,     // hver vei. Tur-retur ≈ 0,90
    margin: 0.15,            // strøm kjøpt fra nettet til batteriet må gi minst 15 % fortjeneste etter tap
    horisont: 36,            // timer planen ser fram (i dag og i morgen til middag, når spotprisene er kjent)
    brukTimer: 24,           // timer av planen som brukes før neste planlegging
    startNivaa: 0.5,         // batteriet starter halvfullt 1. januar
    spredning: 0.0005,       // kvadratisk straff (kr/kWh²) som sprer lading fra nettet over flere timer
    syklusStraff: 0.005,     // kr/kWh ved utlading, hindrer småsykluser uten gevinst
    takStraff: 20,           // kr/kWh for kjøp over valgt tak (gjør taket nesten absolutt)
    takForsok: 10,           // antall tak som prøves per måned (pluss ett halvt steg på hver side av det beste)
    minTrinn: 24,            // laveste antall trinn for ladetilstanden
    maksTrinn: 96            // høyeste antall trinn for ladetilstanden
  };

  // ── Kalender ───────────────────────────────────────────────────
  const DAG_FOR_MND = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  function mndFraIndeks(i) { const d = Math.floor(i / 24); let m = 11; while (m > 0 && DAG_FOR_MND[m] > d) m--; return m; }
  function mndStart(m) { return DAG_FOR_MND[m] * 24; }
  function mndSlutt(m) { return (m < 11 ? DAG_FOR_MND[m + 1] : 365) * 24; }
  // Datoen for en time i rutenettet i et gitt år (til ukedag og helg)
  function datoFraIndeks(i, aar) {
    const m = mndFraIndeks(i), dag = Math.floor(i / 24) - DAG_FOR_MND[m] + 1;
    return new Date(aar, m, dag, i % 24);
  }

  // ── Forbruk til 8760 timer ─────────────────────────────────────
  // maalinger: [{ ts: Date eller tekst, kwh: tall }] i lokal klokketid. Kvarters- og minuttverdier summeres til
  // hele timer. Finnes samme time flere ganger (mer enn ett år, eller klokka stilles tilbake), brukes snittet.
  // Timer som mangler (klokka stilles fram, eller hull), får snittet for samme klokkeslett i samme måned.
  // Gir { timer: Float64Array(8760), mangler: antall timer som ble fylt inn, aar: året med flest målinger }.
  function forbrukTil8760(maalinger) {
    const perTime = new Map(), aarTeller = {};
    for (const r of maalinger || []) {
      const d = r.ts instanceof Date ? r.ts : new Date(r.ts);
      const v = +r.kwh; if (isNaN(d) || !isFinite(v)) continue;
      const n = Math.floor(+d / 3600000);
      perTime.set(n, (perTime.get(n) || 0) + v);
    }
    const sum = new Float64Array(8760), ant = new Uint16Array(8760);
    const mh = Array.from({ length: 12 }, () => new Array(24).fill(0)), mn = Array.from({ length: 12 }, () => new Array(24).fill(0));
    perTime.forEach((v, n) => {
      const d = new Date(n * 3600000), m = d.getMonth(), dag = d.getDate(), t = d.getHours();
      aarTeller[d.getFullYear()] = (aarTeller[d.getFullYear()] || 0) + 1;
      mh[m][t] += v; mn[m][t]++;
      if (m === 1 && dag === 29) return;
      const i = (DAG_FOR_MND[m] + dag - 1) * 24 + t;
      sum[i] += v; ant[i]++;
    });
    const timer = new Float64Array(8760); let mangler = 0;
    for (let i = 0; i < 8760; i++) {
      if (ant[i]) { timer[i] = sum[i] / ant[i]; continue; }
      const m = mndFraIndeks(i), t = i % 24;
      timer[i] = mn[m][t] ? mh[m][t] / mn[m][t] : 0; mangler++;
    }
    const aar = Object.keys(aarTeller).sort((a, b) => aarTeller[b] - aarTeller[a])[0];
    return { timer, mangler, aar: aar ? +aar : null };
  }

  // ── Sommertid ──────────────────────────────────────────────────
  // Solproduksjon (PVGIS, HelioScope o.l.) er i normaltid. Forbruk og spotpriser er i klokketid. Fra kl. 02 siste
  // søndag i mars til kl. 02 siste søndag i oktober flyttes rekken én time. Endrer arr og gir den tilbake.
  function sommertid(arr, aar) {
    const sisteSondag = m => { const d = new Date(aar, m + 1, 0); return d.getDate() - d.getDay(); };
    const start = (DAG_FOR_MND[2] + sisteSondag(2) - 1) * 24 + 2, slutt = (DAG_FOR_MND[9] + sisteSondag(9) - 1) * 24 + 2;
    for (let i = slutt - 1; i >= start; i--) arr[i] = arr[i - 1];
    return arr;
  }

  // ── Spotpriser til 8760 timer ──────────────────────────────────
  // priser: [{ t: tidspunkt (UTC-tekst eller Date), ore: øre/kWh }]. Kvartersverdier snittes til timer.
  // Timer uten pris får nærmeste kjente.
  function spotTil8760(priser) {
    const sum = new Array(8760).fill(0), ant = new Array(8760).fill(0);
    (priser || []).forEach(p => {
      const d = new Date(p.t); if (isNaN(d)) return;
      const m = d.getMonth(), dag = d.getDate(), t = d.getHours();
      if (m === 1 && dag === 29) return;
      const i = (DAG_FOR_MND[m] + dag - 1) * 24 + t;
      if (i < 0 || i >= 8760) return;
      sum[i] += +p.ore; ant[i]++;
    });
    const ut = sum.map((v, i) => ant[i] ? v / ant[i] : null);
    let siste = null;
    for (let i = 0; i < 8760; i++) { if (ut[i] == null) ut[i] = siste; else siste = ut[i]; }
    for (let i = 8759; i >= 0; i--) { if (ut[i] == null) ut[i] = ut[i + 1] != null ? ut[i + 1] : 0; }
    return ut;
  }

  // ── Nettariff ──────────────────────────────────────────────────
  // To typer tariff (satser i øre/kWh og kroner):
  //  Effekttariff (stor næring):
  //    { type: 'effekt', energiFlat?: øre, energiVinter?: øre, energiSommer?: øre,
  //      effektVinter: kr/kW/mnd, effektSommer: kr/kW/mnd, fastledd: kr/mnd, vinterMnd?: [10,11,0,1,2,3] }
  //    Effekten er den høyeste timen i måneden.
  //  Kapasitetstrinn (privat og liten næring):
  //    { type: 'trinn', energiDag: øre, energiNatt: øre, trinn: [[fraKw, tilKw|null, kr/mnd], …] }
  //    Effekten er snittet av de tre høyeste døgntoppene (på tre forskjellige døgn).
  //  Vinter er oktober–mars (månedene 0–2 og 9–11) hvis ikke vinterMnd er gitt.
  function erVinter(m, tariff) { return tariff && tariff.vinterMnd ? tariff.vinterMnd.includes(m) : (m <= 2 || m >= 9); }

  // Energiledd + avgifter time for time i kr/kWh. avgiftOre: elavgift (+ Enova-avgift for privat) i øre/kWh.
  // Trinntariff: dagpris hverdager kl. 06–22, nattpris ellers og hele helgen.
  function nettTimer(tariff, mvaF, aar, avgiftOre) {
    const ut = new Float64Array(8760), f = +mvaF || 1, avg = +avgiftOre || 0;
    for (let i = 0; i < 8760; i++) {
      let e;
      if (tariff.type === 'effekt') e = tariff.energiFlat != null ? +tariff.energiFlat || 0
        : (erVinter(mndFraIndeks(i), tariff) ? +tariff.energiVinter || 0 : +tariff.energiSommer || 0);
      else {
        const d = datoFraIndeks(i, aar), t = i % 24, helg = d.getDay() === 0 || d.getDay() === 6;
        e = (!helg && t >= 6 && t < 22) ? (+tariff.energiDag || 0) : (+tariff.energiNatt || 0);
      }
      ut[i] = (e + avg) * f / 100;
    }
    return ut;
  }

  // Effektleddet for én måned. timer = kjøp fra nettet time for time i måneden (første = kl. 00 den 1.).
  // Gir { kw, kr, fast, maks, tre } i kroner med moms (mvaF).
  function effektMnd(timer, m, tariff, mvaF) {
    const f = +mvaF || 1, dager = Math.floor(timer.length / 24), dogn = []; let maks = 0;
    for (let d = 0; d < dager; d++) {
      let topp = 0; for (let t = 0; t < 24; t++) topp = Math.max(topp, timer[d * 24 + t] || 0);
      dogn.push(topp); maks = Math.max(maks, topp);
    }
    const tre = dogn.slice().sort((a, b) => b - a).slice(0, 3);
    const kw = tariff.type === 'effekt' ? maks : tre.reduce((a, b) => a + b, 0) / Math.max(1, tre.length);
    let kr = 0, fast = 0;
    if (tariff.type === 'effekt') {
      kr = kw * (erVinter(m, tariff) ? (+tariff.effektVinter || 0) : (+tariff.effektSommer || 0));
      fast = +tariff.fastledd || 0;
    } else {
      const tr = tariff.trinn || [];
      const rad = tr.find(t => t[1] === null ? kw >= t[0] : kw >= t[0] && kw < t[1]) || tr[tr.length - 1] || [0, null, 0];
      kr = +rad[2] || 0;
    }
    return { kw, kr: kr * f, fast: fast * f, maks, tre };
  }
  // Hele året. timer: 8760 timer kjøp fra nettet. Gir { perMnd, sum, fast }.
  function effektledd(timer, tariff, mvaF) {
    const perMnd = []; let sum = 0, fast = 0;
    for (let m = 0; m < 12; m++) {
      const r = effektMnd(Array.prototype.slice.call(timer, mndStart(m), mndSlutt(m)), m, tariff, mvaF);
      perMnd.push(r); sum += r.kr; fast += r.fast;
    }
    return { perMnd, sum, fast };
  }

  // ── Kjøps- og salgspris time for time ──────────────────────────
  // o: { spot: 8760 øre/kWh uten moms, nett: 8760 kr/kWh (fra nettTimer) eller ett tall, mvaF: 1,25 privat / 1 næring,
  //      paaslagOre: påslag hos leverandøren i øre/kWh uten moms,
  //      avtale: 'spot' | 'fast' | 'norgespris' | 'landbruk', fastprisKr: kraftpris i kr/kWh (avtale 'fast', med moms for privat) }
  // Salg er alltid spot time for time uten moms.
  function prisserier(o) {
    const f = +o.mvaF || 1, paaslag = (+o.paaslagOre || 0) * f / 100, avtale = o.avtale || 'spot';
    const kjop = new Float64Array(8760), salg = new Float64Array(8760);
    for (let i = 0; i < 8760; i++) {
      const s = o.spot ? +o.spot[i] || 0 : 0;
      const n = typeof o.nett === 'number' ? o.nett : (o.nett ? o.nett[i] : 0);
      let kraft;
      if (avtale === 'fast') kraft = +o.fastprisKr || 0;
      else if (avtale === 'norgespris') kraft = 0.40 * f;
      else if (avtale === 'landbruk') kraft = (s * f <= 77 ? s * f : 77 + (s * f - 77) * 0.20) / 100;
      else kraft = s * f / 100;
      kjop[i] = kraft + paaslag + n;
      salg[i] = s / 100;
    }
    return { kjop, salg };
  }

  // ── Planleggeren ───────────────────────────────────────────────
  // Planlegger batteriet time for time gjennom året med dynamisk programmering. Ser «horisont» timer fram og bruker
  // de første «brukTimer». For hver måned prøves flere tak for kjøp fra nettet, og taket som gir lavest regning
  // totalt (energi + effektledd) velges. Lønner det seg mer å handle på pris enn å kappe toppene, kappes de ikke.
  //
  //   o: { net: 8760 kWh (forbruk - sol, positiv = kjøp), kjop: 8760 kr/kWh, salg: 8760 kr/kWh,
  //        kap: kWh, kw: maks effekt inn og ut (standard kap/2), tariff?: se over, mvaF?: 1,25 / 1,
  //        nivaa?: minste antall trinn, res?: reservasjon (se under) }
  //   gir { ac: Float64Array(8760) kWh inn i (+) eller ut av (-) batteriet på nettsiden,
  //         tak: kW per måned (Infinity = intet tak), kost: regningen for året som planen ga }
  //
  //   res (valgfritt, f.eks. frekvensmarked): { kw: 8760 kW som er meldt inn, lo: 8760 kWh, hi: 8760 kWh }.
  //   I timer med kw > 0 har batteriet bare effekten som er igjen, og ladetilstanden må ligge mellom lo og hi.
  function planlegg(o) {
    const S = INNSTILLINGER;
    const kap = +o.kap || 0, eff = S.virkningsgrad, P = +o.kw > 0 ? +o.kw : kap / 2;
    const ut = { ac: new Float64Array(8760), tak: new Array(12).fill(Infinity), kost: 0 };
    if (kap <= 0 || P <= 0) return ut;
    const N = Math.max(o.nivaa || S.minTrinn, Math.min(S.maksTrinn, Math.ceil(kap / (P * eff))));
    const dE = kap / N;
    const opp = Math.max(1, Math.floor(P * eff / dE + 1e-9));
    const ned = Math.max(1, Math.floor(P / eff / dE + 1e-9));
    const net = o.net, kjop = o.kjop, salg = o.salg, H = S.horisont;

    const timeKost = (h, k, tak) => {
      const ac = k > 0 ? k * dE / eff : k * dE * eff;
      const g = net[h] + ac;
      let c = g > 0 ? g * kjop[h] : g * salg[h];
      if (k > 0) {
        const fraNett = Math.max(0, Math.min(ac, g));
        c += fraNett * kjop[h] * S.margin + S.spredning * fraNett * fraNett * Math.min(1, 1000 / P);
      } else if (k < 0) c += -ac * S.syklusStraff;
      if (g > tak) c += (g - tak) * S.takStraff;
      return c;
    };

    const V = new Float64Array((H + 1) * (N + 1)), valg = new Int8Array(H * (N + 1));
    const R = o.res && o.res.kw ? o.res : null;
    const planVindu = (h0, s0, bruk, tak) => {
      const W = Math.min(H, 8760 - h0);
      for (let s = 0; s <= N; s++) V[W * (N + 1) + s] = 0;
      for (let t = W - 1; t >= 0; t--) {
        const h = h0 + t;
        let oH = opp, nH = ned, lo = 0, hi = N;
        if (R && R.kw[h] > 0) {
          const Pf = Math.max(0, P - R.kw[h]);
          oH = Math.floor(Pf * eff / dE + 1e-9); nH = Math.floor(Pf / eff / dE + 1e-9);
          lo = Math.ceil(R.lo[h] / dE - 1e-9); hi = Math.floor(R.hi[h] / dE + 1e-9);
          if (lo > hi) lo = hi = Math.round(N / 2);
        }
        for (let s = 0; s <= N; s++) {
          let best = Infinity, bk = 0;
          const kMin = Math.max(-nH, -s), kMax = Math.min(oH, N - s);
          for (let k = kMin; k <= kMax; k++) {
            if (s + k < lo || s + k > hi) continue;
            const v = timeKost(h, k, tak) + V[(t + 1) * (N + 1) + s + k];
            if (v < best) { best = v; bk = k; }
          }
          if (best === Infinity) { best = timeKost(h, 0, tak) + 1000 + V[(t + 1) * (N + 1) + s]; bk = 0; }
          V[t * (N + 1) + s] = best; valg[t * (N + 1) + s] = bk;
        }
      }
      const steg = []; let s = s0;
      for (let t = 0; t < Math.min(bruk, W); t++) { const k = valg[t * (N + 1) + s]; steg.push(k); s += k; }
      return { steg, s };
    };

    const kjorMnd = (m, s0, tak) => {
      const h0 = mndStart(m), h1 = mndSlutt(m);
      const ac = new Float64Array(h1 - h0), imp = new Float64Array(h1 - h0);
      let s = s0, energi = 0;
      for (let h = h0; h < h1; h += S.brukTimer) {
        const p = planVindu(h, s, Math.min(S.brukTimer, h1 - h), tak);
        p.steg.forEach((k, i) => {
          const a = k > 0 ? k * dE / eff : k * dE * eff, g = net[h + i] + a;
          ac[h + i - h0] = a; imp[h + i - h0] = Math.max(0, g);
          energi += g > 0 ? g * kjop[h + i] : g * salg[h + i];
        });
        s = p.s;
      }
      const effKr = o.tariff ? effektMnd(imp, m, o.tariff, o.mvaF || 1).kr : 0;
      return { ac, s, kost: energi + effKr, h0 };
    };

    let s = Math.round(N * S.startNivaa);
    for (let m = 0; m < 12; m++) {
      const h0 = mndStart(m), h1 = mndSlutt(m);
      let maks = 0, snitt = 0; for (let h = h0; h < h1; h++) { maks = Math.max(maks, net[h]); snitt += Math.max(0, net[h]); }
      snitt /= (h1 - h0);
      let best = kjorMnd(m, s, Infinity); best.tak = Infinity;
      const prov = t => { const r = kjorMnd(m, s, t); if (r.kost < best.kost - 0.01) { best = r; best.tak = t; } };
      if (o.tariff && maks > 0) {
        const lav = Math.max(snitt, maks - P, 0), steg = (maks - lav) / S.takForsok;
        if (steg > 0.01) {
          for (let j = 0; j < S.takForsok; j++) prov(lav + steg * j);
          if (isFinite(best.tak)) for (const d of [-0.5, 0.5]) prov(Math.max(lav, Math.min(maks, best.tak + steg * d)));
        }
      }
      ut.ac.set(best.ac, best.h0); ut.tak[m] = best.tak; ut.kost += best.kost; s = best.s;
    }
    return ut;
  }

  // ── Simulering og strømregning ─────────────────────────────────
  // Kjører planen (eller enkel solstyring) gjennom året og regner regningen med og uten anlegg.
  //   o: { forbruk: 8760 kWh, sol?: 8760 kWh (allerede i klokketid), kjop, salg: 8760 kr/kWh,
  //        kapKwh: batteri kWh (0 = intet batteri), kw?: maks effekt (standard kap/2),
  //        smart?: true = planleggeren, false = bare soloverskudd lagres,
  //        tariff?, mvaF?, res?: se planlegg, nett?: 8760 kr/kWh energiledd+avgift (bare for å dele opp gevinsten) }
  //   gir { timer: { import, eksport, ladNett, battUt, ac }, plan, sum: {...}, okonomi: {...} }
  //   okonomi.gevinst = regningen uten sol og batteri minus regningen med (kroner, år 1), inkl. salg og effektledd.
  //   For batteriets egen gevinst: kjør med kapKwh = 0 og med batteri, og trekk fra.
  function simuler(o) {
    const S = INNSTILLINGER, EFF = S.virkningsgrad;
    const cons = o.forbruk, sol = o.sol || null, kjop = o.kjop, salg = o.salg;
    const kap = +o.kapKwh || 0, P = +o.kw > 0 ? +o.kw : kap / 2;
    const net = new Float64Array(8760);
    for (let i = 0; i < 8760; i++) net[i] = (+cons[i] || 0) - (sol ? +sol[i] || 0 : 0);
    const plan = (o.smart && kap > 0) ? planlegg({ net, kjop, salg, kap, kw: P, tariff: o.tariff, mvaF: o.mvaF, res: o.res }) : null;

    const tImport = new Float64Array(8760), tEksport = new Float64Array(8760), tLadNett = new Float64Array(8760), tBattUt = new Float64Array(8760);
    let soc = kap * S.startNivaa, socKjopt = 0;
    let regningFor = 0, kjopKr = 0, salgKr = 0, nettFor = 0, nettEtter = 0;
    let sumEgen = 0, sumDirekte = 0, sumBattUt = 0, sumLadNett = 0, sumSolgtFraBatt = 0, sumSolgt = 0;
    for (let h = 0; h < 8760; h++) {
      const c = +cons[h] || 0, p = sol ? +sol[h] || 0 : 0;
      const direkte = Math.min(p, c);
      let over = p - direkte, under = c - direkte;
      let battSalg = 0, ladNett = 0, battUt = 0, battUtSol = 0;
      const taUt = levert => {
        const uttak = levert / EFF, andel = soc > 0 ? Math.min(1, socKjopt / soc) : 0;
        socKjopt = Math.max(0, socKjopt - uttak * andel); soc = Math.max(0, soc - uttak);
        return andel;
      };
      if (plan) {
        const ac = plan.ac[h];
        if (ac > 0) {
          const fraSol = Math.min(ac, over);
          ladNett = ac - fraSol; over -= fraSol; under += ladNett;
          soc = Math.min(kap, soc + ac * EFF); socKjopt += ladNett * EFF;
        } else if (ac < 0) {
          const u = Math.min(-ac, soc * EFF);
          battUt = Math.min(u, under); battSalg = u - battUt;
          const andel = taUt(u);
          battUtSol = battUt * (1 - andel); under -= battUt;
        }
      } else if (kap > 0) {
        if (over > 0) {
          const lad = Math.max(0, Math.min(over, (kap - soc) / EFF, P));
          soc += lad * EFF; over -= lad;
        }
        if (under > 0) {
          battUt = Math.max(0, Math.min(under, soc * EFF, P));
          const andel = taUt(battUt);
          battUtSol = battUt * (1 - andel); under -= battUt;
        }
      }
      tImport[h] = under; tEksport[h] = over + battSalg; tLadNett[h] = ladNett; tBattUt[h] = battUt + battSalg;
      regningFor += c * kjop[h]; kjopKr += under * kjop[h]; salgKr += (over + battSalg) * salg[h];
      if (o.nett) { const n = typeof o.nett === 'number' ? o.nett : o.nett[h]; nettFor += c * n; nettEtter += under * n; }
      sumEgen += direkte + battUtSol; sumDirekte += direkte; sumBattUt += battUt; sumLadNett += ladNett;
      sumSolgtFraBatt += battSalg; sumSolgt += over + battSalg;
    }
    const effFor = o.tariff ? effektledd(cons, o.tariff, o.mvaF) : null;
    const effEtter = o.tariff ? effektledd(tImport, o.tariff, o.mvaF) : null;
    const effSpart = effFor ? effFor.sum - effEtter.sum : 0;
    const sumForbruk = Array.prototype.reduce.call(cons, (a, b) => a + (+b || 0), 0);
    const sumSol = sol ? Array.prototype.reduce.call(sol, (a, b) => a + (+b || 0), 0) : 0;
    return {
      timer: { import: tImport, eksport: tEksport, ladNett: tLadNett, battUt: tBattUt, ac: plan ? plan.ac : null },
      plan,
      sum: { forbruk: sumForbruk, sol: sumSol, egenforbrukSol: sumEgen, direkte: sumDirekte, battUt: sumBattUt,
        ladetFraNett: sumLadNett, solgtFraBatt: sumSolgtFraBatt, solgt: sumSolgt,
        soldekning: sumForbruk > 0 ? sumEgen / sumForbruk : 0 },
      okonomi: {
        regningFor: regningFor + (effFor ? effFor.sum : 0),
        regningEtter: kjopKr - salgKr + (effEtter ? effEtter.sum : 0),
        energiSpart: regningFor - kjopKr, effektSpart: effSpart, salg: salgKr,
        gevinst: regningFor - kjopKr + effSpart + salgKr,
        // Til kontantstrømmen: kraft og nettleie vokser med hver sin prisvekst
        deler: { kraft: (regningFor - nettFor) - (kjopKr - nettEtter), nett: (nettFor - nettEtter) + effSpart, salg: salgKr },
        effektFor: effFor, effektEtter: effEtter
      }
    };
  }

  // ── Kontantstrøm over levetiden ────────────────────────────────
  // g: { kraft, nett, salg } kroner år 1 (fra simuler(...).okonomi.deler, eventuelt differansen mot uten batteri),
  //    sol?: andelen av gevinsten som kommer fra sola (0–1, degraderes), annet?: kroner som vokser med strømprisen
  // f: { investering: kr, stotte?: kr, levetid: år, rente: %, vekstStrom: %, vekstNett?: %, degradering?: %/år for sol,
  //      service?: kr/år, ekstra?: { år: kr } (f.eks. { 12: batteribytte }),
  //      laan?: { rente: %, aar: år, egenkapital?: kr },
  //      skatt?: { sats: 0.22, saldosats: 0.10, smaa: 30000 } (næring med saldoavskrivning) }
  // Gir { rader, npv, irr, tilbake, naadd } der tilbake = år til gevinsten har dekket investeringen og rentene.
  function kontantstrom(g, f) {
    const life = Math.max(1, Math.round(f.levetid || 15));
    const netInv = Math.max(0, (+f.investering || 0) - (+f.stotte || 0));
    const vS = (+f.vekstStrom || 0) / 100, vN = (f.vekstNett != null ? +f.vekstNett : +f.vekstStrom || 0) / 100;
    const sol = g.sol == null ? 0 : Math.max(0, Math.min(1, g.sol)), degr = (+f.degradering || 0) / 100;
    const L = f.laan || null;
    const prin = L ? Math.max(0, netInv - Math.min(netInv, +L.egenkapital || 0)) : 0;
    const lr = L ? (+L.rente || 0) / 100 : 0, lt = L ? Math.round(+L.aar || 0) : 0;
    const annuitet = L && prin > 0 && lt > 0 ? (lr === 0 ? prin / lt : prin * lr / (1 - Math.pow(1 + lr, -lt))) : 0;
    const sk = f.skatt || null;
    let saldo = netInv, rest = prin, cumP = 0, cumR = 0, forrigeD = -netInv, tilbake = null;
    const rader = [];
    for (let y = 1; y <= life; y++) {
      const solF = 1 - sol + sol * Math.pow(1 - degr, y - 1);
      const brutto = ((+g.kraft || 0) * Math.pow(1 + vS, y - 1) + (+g.salg || 0) * Math.pow(1 + vS, y - 1)
        + (+g.nett || 0) * Math.pow(1 + vN, y - 1)) * solF + (+g.annet || 0) * Math.pow(1 + vS, y - 1);
      const drift = (+f.service || 0) + ((f.ekstra && f.ekstra[y]) || 0);
      const op = brutto - drift;
      let rente = 0, termin = 0;
      if (L && y <= lt && rest > 0.5) { rente = rest * lr; termin = annuitet; rest = Math.max(0, rest - (termin - rente)); }
      let avskr = 0, skatt = 0;
      if (sk) {
        avskr = saldo < (sk.smaa != null ? sk.smaa : 30000) ? saldo : saldo * (sk.saldosats != null ? sk.saldosats : 0.10);
        saldo -= avskr;
        skatt = (sk.sats != null ? sk.sats : 0.22) * (op - avskr - rente);
      }
      const prosjekt = op - skatt;
      rader.push({ y, brutto, drift, op, rente, termin, avskr, skatt, prosjekt, egen: prosjekt - termin });
      cumP += prosjekt; cumR += rente;
      const d = cumP - cumR - netInv;
      if (tilbake == null && d >= 0) tilbake = (y - 1) + (d > forrigeD ? -forrigeD / (d - forrigeD) : 1);
      forrigeD = d;
    }
    const r = (+f.rente || 0) / 100;
    const cf = [L ? -(netInv - prin) : -netInv].concat(rader.map(x => L ? x.egen : x.prosjekt));
    const npv = cf.reduce((s, v, t) => s + v / Math.pow(1 + r, t), 0);
    const irr = internrente([-netInv].concat(rader.map(x => x.prosjekt)));
    return { rader, npv, irr, tilbake: tilbake != null ? tilbake : life, naadd: tilbake != null, netInvest: netInv };
  }
  function internrente(cf) {
    let r = 0.1;
    for (let it = 0; it < 100; it++) {
      let v = 0, dv = 0;
      for (let t = 0; t < cf.length; t++) { v += cf[t] / Math.pow(1 + r, t); dv -= t * cf[t] / Math.pow(1 + r, t + 1); }
      const nr = r - v / dv;
      if (!isFinite(nr) || nr <= -0.99) return null;
      if (Math.abs(nr - r) < 0.00001) return nr * 100;
      r = nr;
    }
    return null;
  }

  return { INNSTILLINGER, DAG_FOR_MND, mndFraIndeks, datoFraIndeks, forbrukTil8760, sommertid, spotTil8760,
    erVinter, nettTimer, effektMnd, effektledd, prisserier, planlegg, simuler, kontantstrom, internrente };
});
