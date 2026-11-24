# Smart batteri: slik regner beregningen

*Teknisk overlevering fra Nordic Solergy AS, 23.11.2026. Skrevet for den som skal bygge beregningen
inn i en annen lønnsomhetskalkulator, også en KI-assistent som Claude. Alle tall og formler er hentet
direkte fra koden som er i drift. Koden følger med som egen fil: `smart-batteri.js`.*

---

## 1. Kort fortalt

Beregningen simulerer et batteri time for time gjennom ett helt år (8760 timer). For hver time
bestemmer den om batteriet skal lade, stå stille eller tømmes. Den velger det som gir **lavest samlet
strømregning for måneden**, med alle disse delene:

- kraftpris (spot eller fastpris) med påslag og moms,
- energiledd og elavgift time for time (dag, natt, helg, sommer og vinter),
- effektledd eller kapasitetstrinn, altså månedens effekttopper,
- salg av overskudd til spotpris,
- tap i batteriet og et krav om fortjeneste før det lønner seg å handle med nettet.

Planleggingen bruker dynamisk programmering med 36 timers utsyn. Det tilsvarer omtrent det et ekte
smart batteri vet når morgendagens spotpriser er publisert kl. 13. For hver måned prøves flere
«tak» for kjøp fra nettet, og den kombinasjonen som gir lavest regning, blir valgt.

Resultatet er en timeserie for batteriet. Den brukes til å regne strømregningen med og uten batteri.
Differansen er årsgevinsten, og kontantstrømmen over levetiden bygges av den.

---

## 2. Dette må finnes før man kan regne

| Data | Oppløsning | Kommentar |
|---|---|---|
| **Forbruk** | **Time for time, helst ett helt år (8760 timer)** | **Absolutt forutsetning.** Effekttoppene og prisforskjellene innen døgnet er hele grunnlaget for gevinsten. Månedstall eller et standard døgn gir feil svar: toppene forsvinner, og batteriet ser ut til å tjene mindre (eller mer) enn det gjør. Kilden er normalt Elhub eller måledata fra nettselskapet (CSV eller Excel). Kvarters- eller minuttverdier summeres til hele timer. |
| Produksjon fra sol (valgfritt) | Time for time, 8760 | PVGIS, HelioScope eller egen modell. Er normalt i **normaltid**, og må flyttes én time i sommertid (se 3.1). Uten sol regnes rent batteri. |
| Spotpris | Time for time, 8760, øre/kWh | ENTSO-E for riktig prisområde (NO1–NO5). Kvartersverdier snittes til timer. Brukes til salg alltid, og til kjøp når kunden har spotavtale. |
| Nettariff | Satser | Energiledd (dag/natt eller sommer/vinter), effektledd (kr/kW per måned, sommer/vinter) eller kapasitetstrinn (kr/mnd per trinn), fastledd. Per nettselskap og kundetype. |
| Avgifter | Satser | Elavgift (2026: 7,13 øre/kWh, redusert 0,60, fritak i tiltakssonen), Enova-avgift (privat 1 øre/kWh, næring fast 800 kr/år, så den spares ikke). |
| Påslag | øre/kWh | Leverandørens påslag (standard 5 øre eks. mva). |
| Batteri | kWh og kW | Kapasitet (kWh) og maks effekt inn og ut (kW, normalt inverteren). Uten oppgitt effekt brukes 0,5C (kW = kWh / 2). |

### Hvis forbruket bare finnes som månedstall

Da kan beregningen ikke gjøres riktig. Det minste man bør kreve, er timeverdier for minst noen
måneder, helst vintermånedene. Standardprofiler for kunder uten timedata finnes, men de er bare egnet til grove anslag for sol, ikke til batteri. Si det tydelig til kunden.

---

## 3. Grunnlaget time for time

Alt legges i samme rutenett: indeks `i = 0 … 8759`, der 0 er 1. januar kl. 00–01. 29. februar hoppes
over. Måned for en indeks finnes fra dagnummeret (`DAG_FOR_MND = [0,31,59,90,120,151,181,212,243,273,304,334]`).

### 3.1 Forbruk og produksjon

- **Forbruk:** hver måling havner på sin dato og sitt klokkeslett. Bruk ikke et snittdøgn. Finnes
  samme time flere ganger (fila dekker mer enn ett år, eller klokka stilles tilbake om høsten),
  brukes snittet. Timer som mangler (klokka stilles fram om våren, eller hull i fila), får snittet
  for samme klokkeslett i samme måned.
- **Produksjon:** er i normaltid. Fra kl. 02 siste søndag i mars til kl. 02 siste søndag i oktober
  flyttes rekken én time fram, så sola møter forbruket og prisene i riktig klokketime:
  `for i = slutt-1 ned til start: prod[i] = prod[i-1]`.
- **Ekstra last (valgfritt):** for eksempel en DC-hurtiglader legges til forbruket i sine timer, så
  batteriet og effektleddet regnes med den.
- **Netto per time:** `net[i] = forbruk[i] - sol[i]` (kWh, som også er snitt-kW den timen).
  Positiv betyr kjøp fra nettet, negativ betyr overskudd.

### 3.2 Kjøpspris og salgspris per time (kr/kWh)

```
mvaF   = 1,25 for privat, 1,00 for næring
nett[i] = (energiledd[i] + elavgift + enovaavgift_privat) * mvaF / 100
          energiledd[i]: dag (hverdag 06-22) / natt og helg for privat og små bedrifter,
                         eller flat / sommer-vinter for effekttariff (stor næring)

Spotavtale:   kjop[i] = spot[i] * mvaF / 100 + nett[i] + paaslag * mvaF / 100
Fastpris:     kjop[i] = fastpris + paaslag * mvaF / 100 + nett[i]
Norgespris:   kjop[i] = 0,40 * mvaF + nett[i]
Landbruk:     kraft = spot <= 77 ? spot : 77 + (spot - 77) * 0,20   (øre)

Salg:         salg[i] = spot[i] / 100      (alltid spot time for time, uten moms, også med fastpris)
```

Effektleddet ligger **ikke** i `kjop[i]`. Det regnes for hele måneden (3.3).

### 3.3 Effektledd: hvordan toppen måles

Effekten måles alltid på **strømmen som kjøpes fra nettet** (`import[i] = max(0, net[i] + batteri[i])`).

| Tariff | Effekt som teller | Kostnad |
|---|---|---|
| **Effekttariff** (stor næring, over 100 000 kWh/år) | **Høyeste time i måneden** | `kW * sats` (kr/kW, vinter okt–mar eller sommer apr–sep; noen selskap har egne vintermåneder) + fastledd |
| **Kapasitetstrinn** (privat og liten næring) | **Snittet av de tre høyeste døgntoppene** (døgnets høyeste time, på tre forskjellige døgn) | Fast kr/mnd for trinnet effekten havner i, for eksempel 0–2, 2–5, 5–10 … kW |

Satsene varierer mye mellom nettselskapene. Bruk satsene for riktig selskap og år.

---

## 4. Planleggeren (kjernen)

### 4.1 Faste parametre

| Navn | Verdi | Betydning |
|---|---|---|
| `VIRKN` | 0,95 | Virkningsgrad hver vei. Tur-retur er 0,95 × 0,95 ≈ 0,90. |
| `MARGIN` | 0,15 | Strøm kjøpt fra nettet til batteriet må gi minst 15 % fortjeneste etter tap, ellers lønner det seg ikke. |
| `HORISONT` | 36 timer | Hvor langt fram planen ser. Planen brukes for de første 24 timene, så planlegges neste døgn. |
| `P` | kW | Maks effekt inn og ut. Standard kWh / 2. |
| Startnivå | 50 % | Batteriet starter halvfullt 1. januar. |

### 4.2 Ladetilstand i trinn

Ladetilstanden deles i `N` like trinn:

```
N  = max(24, min(96, ceil(kap / (P * VIRKN))))
dE = kap / N                                   (kWh per trinn)
opp = max(1, floor(P * VIRKN / dE))            (maks trinn opp per time, strøm inn <= P)
ned = max(1, floor(P / VIRKN / dE))            (maks trinn ned per time, strøm ut <= P)
```

En handling `k` (heltall fra `-ned` til `+opp`) gir strøm på nettsiden:

```
ac = k > 0 ? k * dE / VIRKN      (lading: mer strøm inn enn det som lagres)
           : k * dE * VIRKN      (utlading: mindre strøm ut enn det som tas fra batteriet)
```

### 4.3 Kostnaden for én time

For time `h`, handling `k` og et tak `tak` (kW) for kjøp fra nettet:

```
g = net[h] + ac                              netto mot nettet etter batteriet
c = g > 0 ? g * kjop[h] : g * salg[h]        kjøp koster, salg gir inntekt (negativ kostnad)

hvis k > 0 (lading):
    fraNett = max(0, min(ac, g))             den delen av ladingen som kommer fra nettet
    c += fraNett * kjop[h] * MARGIN          krav om fortjeneste
    c += 0,0005 * fraNett^2 * min(1, 1000 / P)
         (liten kvadratisk straff: sprer ladingen over flere billige timer i stedet for full
          effekt i én time, så ladingen ikke lager nye topper. For batterier over 1 MW skaleres den
          med effekten, så store batterier ikke straffes mer enn små.)
hvis k < 0 (utlading):
    c += -ac * 0,005                         hindrer småsykluser uten gevinst (0,5 øre/kWh)

hvis g > tak:
    c += (g - tak) * 20                      kjøp over taket er nesten forbudt (20 kr/kWh)
```

Merk: når det er soloverskudd (`net < 0`), koster lading fra sol bare salgsprisen man går glipp av.
Da blir det automatisk riktig å lagre sol når prisen senere blir høyere, og å selge med en gang når
det er verdt mer nå.

### 4.4 Dynamisk programmering over 36 timer

```
V[W][s] = 0 for alle s                       (W = min(36, timer igjen av året))
for t = W-1 ned til 0:
    for hver ladetilstand s = 0 … N:
        V[t][s] = min over k i [max(-ned, -s), min(opp, N-s)] av
                  timeKost(h0+t, k, tak) + V[t+1][s+k]
        husk beste k
Fra startnivået s0: følg beste k for de første 24 timene. Det gir nytt startnivå for neste døgn.
```

Det finnes ingen verdi for strømmen som er igjen i batteriet på slutten av vinduet (`V[W] = 0`).
Derfor tømmer planen batteriet mot slutten av de 36 timene, men bare de første 24 brukes, så
effekten er liten.

### 4.5 Taket for effekttoppen, måned for måned

Effektleddet avhenger av hele måneden, ikke av én time. Derfor regnes hver måned flere ganger med
forskjellige tak:

```
for hver måned m:
    maks  = høyeste net[h] i måneden (toppen uten batteri)
    snitt = snittet av max(0, net[h]) i måneden
    beste = kjør måneden uten tak (tak = uendelig)
    hvis nettariffen er kjent og maks > 0:
        lav  = max(snitt, maks - P, 0)       (lavere enn dette kan batteriet ikke klare)
        steg = (maks - lav) / 10
        prøv tak = lav + steg * j, for j = 0 … 9
        prøv også ± et halvt steg rundt det beste taket
    For hvert tak: kjør måneden dag for dag (4.4), summer energikostnaden og legg til
    effektleddet regnet av import-timene (3.3). Taket med lavest SUM vinner.
    Neste måned starter med ladetilstanden der denne sluttet.
```

**Viktig konsekvens:** batteriet kapper toppene bare når det lønner seg mer enn å bruke kapasiteten
til prishandel. Med høy vintersats for effekt (for eksempel 111 kr/kW) blir toppene kappet hardt.
Med lav sommersats (for eksempel 46 kr/kW) kan det lønne seg mer å lade billig fra nettet og bruke
eller selge strømmen dyrt. Da kan ladingen selv lage en ny topp, og effektleddet blir høyere enn
uten batteri den måneden, selv om totalen er lavere. Det er riktig økonomisk, men ser rart ut i en
tabell. Vil kunden at batteriet alltid skal holde toppene nede, må taket låses (for eksempel til
vintertaket hele året) eller straffen over taket gjøres høyere.

### 4.6 Ut av planleggeren

- `ac[h]`: kWh inn i (+) eller ut av (-) batteriet på nettsiden, for hver av de 8760 timene.
- `tak[m]`: valgt tak per måned (uendelig = ingen kapping).

---

## 5. Fra plan til strømregning

Planen kjøres gjennom en enkel simulering time for time, som også fordeler strømmen:

```
direkte  = min(sol, forbruk)                 sol brukt med en gang
overskudd = sol - direkte
underskudd = forbruk - direkte

ac > 0 (lading):  fraSol = min(ac, overskudd); fraNett = ac - fraSol
                  overskudd -= fraSol; underskudd += fraNett
ac < 0 (utlading): ut = min(-ac, lagret * VIRKN)
                  tilEget = min(ut, underskudd); tilSalg = ut - tilEget
                  underskudd -= tilEget

import[h] = underskudd
eksport[h] = overskudd + tilSalg
```

Batteriet holder rede på hvor mye av innholdet som er sol og hvor mye som er kjøpt fra nettet.
Strøm tas ut i samme forhold. Bare solandelen teller som soldekning i rapporten.

**Regningen for året:**

```
uten batteri (og uten sol):  sum forbruk[h] * kjop[h]  + effektledd(forbruk)
med batteri:                  sum import[h] * kjop[h]  - sum eksport[h] * salg[h]
                              + effektledd(import)

gevinst år 1 = regning uten - regning med
             = (kraft spart) + (energiledd og avgift spart) + (effektledd spart) + salg
```

Del gevinsten i kraft, nettleie (inkludert effektledd) og salg. Delene vokser med hver sin
prisvekst i kontantstrømmen.

**For å finne batteriets egen gevinst:** regn én gang med sol og uten batteri, og én gang med sol og
batteri. Differansen er batteriets bidrag.

---

## 6. Uten smart styring (til sammenligning)

Når smart styring er av, lagrer batteriet bare soloverskudd (begrenset av kW og ledig plass), og
tømmes når forbruket er større enn sola. Det kjøper aldri fra nettet og bryr seg ikke om pris eller
effekt. Sammenlign alltid med denne. Det viser hva styringen faktisk er verdt.

---

## 7. Økonomien over levetiden

```
for år y = 1 … levetid:
    brutto = (kraft + salg) * (1 + vekstStrøm)^(y-1)
           + nettleie       * (1 + vekstNett)^(y-1)
           (solandelen degraderes også, 0,15 %/år, men det gjelder bare sola)
    drift  = service per år (for eksempel +5 000 kr/år for batteri) + batteribytte i år 12 (70 % av prisen)
    rente  = lån: restgjeld * rente (annuitet)
    næring med avskrivning: saldoavskrivning (gruppe j 10 % av restverdien; under 30 000 kr føres alt)
                            skatt = 22 % * (brutto - drift - avskrivning - rente)
    kontantstrøm = brutto - drift - skatt

tilbakebetaling = første år der sum kontantstrøm - sum renter >= investering etter støtte
                  (lånet utsetter den bare med rentene)
NPV  = kontantstrømmene neddiskontert med kalkulasjonsrenten (med lån: egenkapital og terminbeløp)
IRR  = prosjektets internrente (uten lån)
```

Batteripris: ferdig installert pris per kWh (vi bruker utsalgspris med påslag og tilkobling, ellers
rundt 2 850 kr/kWh eks. mva). Moms legges til for privat.

**Optimal størrelse:** hele beregningen (punkt 3–7) kjøres for flere størrelser, for eksempel
0, 50, 100 … 500 kWh med kW = kWh / 2. Den størrelsen som gir høyest NPV, er den beste. Hver størrelse
er en full helårsplanlegging. Med store batterier tar det rundt ett sekund per størrelse, så kjør
dem én og én og la siden puste i mellom.

---

## 8. Valgfritt: frekvensmarkedet

Beregningen kan også melde batteriet inn i Statnetts reservemarkeder (FCR-N, FFR, mFRR kapasitet og
energi) gjennom en aggregator:

- Satsene er per prisområde (Entelios 2025, per MW og time).
- Først kjøres smart batteri uten markedet. Så anslås hva batteriet er verdt for kunden hver time.
- Markedet får timene der det betaler mer enn eget bruk, etter aggregatorens andel (standard 20 %).
- I reserverte timer har planleggeren mindre effekt, og ladetilstanden må ligge i et bånd som gjør at
  batteriet kan levere.
- Til slutt kjøres smart batteri på nytt med de reserverte timene.

Dette er en egen modul og kan tas med eller utelates.

---

## 9. Forutsetninger og svakheter (si dem til kunden)

1. **Planleggeren vet forbruk og sol 36 timer fram.** Et ekte batteri vet prisene, men må gjette
   forbruk og sol. Resultatet er derfor et øvre anslag på det styringen kan få til, særlig for
   effekttoppene. Et batteri som skal kappe en topp, må vite når toppen kommer.
2. **Ett år med timedata blir brukt som «normalår»,** med spotprisene fra de siste tolv månedene.
   Et år med uvanlige priser gir et uvanlig resultat.
3. **Prisvekst, rente og levetid** er antakelser. Vis gjerne flere scenarier.
4. **Batteriets aldring** er forenklet til et bytte i år 12 (70 % av prisen). Gradvis tap av
   kapasitet og en grense for antall sykluser er ikke med.
5. **Virkningsgraden** er fast (0,95 hver vei). Den er lavere ved lav effekt og når inverteren går
   på tomgang.
6. **Effektleddet** er regnet etter satsene som legges inn. Sjekk tariffbladet til nettselskapet,
   for satsene endrer seg ofte og varierer mye.
7. **Salg** regnes til spotpris uten tillegg. Avtaler med plusskunde-tillegg eller trekk må legges
   inn for seg.

---

## 10. Sjekkliste for å bygge det inn

1. Les forbruket til et 8760-rutenett (punkt 3.1). Avvis eller varsle når det mangler timedata.
2. Hent spotpriser for prisområdet og legg dem i samme rutenett.
3. Lag `kjop[i]`, `salg[i]` og `nett[i]` (punkt 3.2), og velg måten effekten måles på (punkt 3.3).
4. Regn `net[i] = forbruk - sol` (sol flyttet for sommertid).
5. Kjør planleggeren (punkt 4) og simuleringen (punkt 5). Regn regningen med og uten batteri.
6. Lag kontantstrømmen (punkt 7) og eventuelt en størrelsessammenligning.
7. Test med kjente tilfeller:
   - Flat pris, ingen effekttariff, ingen sol: gevinsten skal være nesten 0 (bare tap).
   - To priser (billig natt, dyr dag) med forskjell under 15 % + tap: batteriet skal ikke handle.
   - Én høy topp i måneden og høy effektsats: toppen skal kappes med opptil batteriets kW.
   - Soloverskudd midt på dagen og høy kveldspris: overskuddet skal lagres og brukes på kvelden.


---

## Koden: smart-batteri.js

All beregningen ligger i én fil, `smart-batteri.js`. Den er ren JavaScript uten avhengigheter og virker
både i nettleseren (`SmartBatteri`) og i Node (`require`). Funksjonene følger punktene over:

| Funksjon | Punkt | Hva den gjør |
|---|---|---|
| `forbrukTil8760(maalinger)` | 3.1 | Måledata `[{ ts, kwh }]` til 8760 timer. Gir også antall timer som ble fylt inn, og året. |
| `sommertid(arr, aar)` | 3.1 | Flytter solproduksjon fra normaltid til klokketid. |
| `spotTil8760(priser)` | 2 | Spotpriser `[{ t, ore }]` til 8760 timer. Kvarter snittes til timer. |
| `nettTimer(tariff, mvaF, aar, avgiftOre)` | 3.2 | Energiledd og avgifter time for time. |
| `prisserier({ spot, nett, mvaF, paaslagOre, avtale, fastprisKr })` | 3.2 | Kjøps- og salgspris time for time. |
| `effektMnd`, `effektledd` | 3.3 | Effektledd eller kapasitetstrinn per måned og for året. |
| `planlegg({ net, kjop, salg, kap, kw, tariff, mvaF, res })` | 4 | Planleggeren. Gir `ac` (8760 timer) og `tak` per måned. |
| `simuler({ forbruk, sol, kjop, salg, kapKwh, kw, smart, tariff, mvaF, nett })` | 5 og 6 | Kjører planen og regner regningen med og uten anlegg. Gir gevinsten delt i kraft, nettleie og salg. |
| `kontantstrom(gevinst, forutsetninger)` | 7 | Kontantstrøm, tilbakebetaling, NPV og IRR, med lån og skatt. |
| `INNSTILLINGER` | 4.1 | Virkningsgrad, margin, horisont og straffene. Kan justeres. |

**Tariff som objekt:**
- Effekttariff: `{ type: 'effekt', energiFlat | energiVinter + energiSommer (øre), effektVinter, effektSommer (kr/kW/mnd), fastledd, vinterMnd? }`
- Kapasitetstrinn: `{ type: 'trinn', energiDag, energiNatt (øre), trinn: [[fraKw, tilKw | null, kr/mnd], …] }`

**Batteriets gevinst:** kjør `simuler` med `kapKwh: 0` og med batteriet, og trekk regningene fra
hverandre.

**Effekten** gjelder på batterisiden. Med virkningsgrad 0,95, og ladenivået delt i hele trinn, kan et
batteri på 20 kW ta ned en topp med rundt 19 kW på nettsiden.

**Kontroll:** planleggeren i fila gir nøyaktig samme plan, time for time, som beregningen vi bruker i
drift. Det er testet med effekttariff, kapasitetstrinn og et batteri på 2 MWh. Tilfellene i
sjekklisten (punkt 10) er testet og stemmer.
