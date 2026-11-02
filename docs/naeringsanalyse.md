# Næringsanalyse (solceller, batteri, lading og flere målere for næringsbygg)

Asbjørns kravbeskrivelse (18.10.2026), presiseringer (21.10.2026) og tilbakemelding (28.10.2026).

## Flyt
1. Dashboardet (lead → «Opprett estimat», næringskunde) viser panelet «Næringsanalyse». Analysen opprettes per lead
   (`calc.business_analyses`) og lagres fortløpende.
2. Selger velger virksomhetstype, driftstid, periode (helt år eller hittil i år), forbruk (årsforbruk, månedsforbruk eller
   målte timer fra fil), takflater (fra solkartet), tariff, avtaler og økonomiske forutsetninger.
3. Skjemaet har fem grupper (bygget og perioden, anlegget, strøm og nettleie, økonomi fremover, kontroll og beregning),
   hver med «Flere innstillinger» og hjelp ved feltene (åpnes ved trykk). «Beregn analyse» lagrer og kjører motoren
   (`POST /api/business/[id]/run`, body `{draft, refresh}`); «Oppdater kildedata» henter spotpriser og PVGIS på nytt.
4. «Opprett estimat»: versjonsruten regner analysen på nytt med kalkylens kWp og sum, kopierer PVGIS- og prisgrunnlaget
   til låste serier, lagrer en låst kjøring (`calc.business_runs`) og legger kundesammendraget i
   `price_data.businessAnalysis`. Mangler noe, lagres `{status: "ikke beregnet", reason}` – aldri en stille nullverdi.
5. pvwebsites viser analysen i tilbudet når `businessAnalysis.status === "beregnet"` (ellers som før).

## Regnemåte
- Time for time i analyseperioden: egenbruk = min(last, sol), import/eksport, avkortning ved eksportgrense.
- Kraft = import × (spot + påslag), salg = eksport × (spot − fratrekk). Nettleie: fastledd per dag, energiledd,
  effektledd = høyeste time i vinduet per måned (helligdager utenfor), sesong og satsendringer midt i året.
- Fastledd og faste gebyrer regnes aldri som spart.
- Levetid: hvert år regnes energiflyten på nytt med degradert produksjon; kraft, nettleie, avgift og drift har egen vekst.
  Nominelle kroner, nominell rente, før skatt og finansiering. Nåverdi, enkel og diskontert tilbakebetaling, internrente.
- Investering fra kalkylen bare når kalkylen ikke inneholder batteri. Ellers «uavklart»: da vises høyeste investering
  som gir positiv nåverdi.

## Kontroll mot Ålesund-kostnadsrapporten (2024, tre målere)
Gjenskapt på øret uten å tilpasse satser: forbruk per måned, fastledd + energiledd, elavgift og effektledd.
Avledet og må bekreftes: helligdager utenfor effektvinduet, effektsatser 35/77 kr/kW fra 1.7.2024, elavgift 0,58 øre.
Uforklart: måler …768 har ~3 200 kr/mnd ekstra nettleie mai–september. Oktoberavviket skyldes sommertid i eksporten.

## Batteri (batteri.ts + engine.ts)
- Batteriet hentes fra tilbudet: batterilinjer i kalkylen (solcelleinvestering = sum minus batterilinjene), ellers anbefalt
  batteri i batteritillegget (moduler, BMS, hybridoppgradering, installasjon). Produktdata: `capacityKwh`, `powerKw`,
  `usablePct`, `roundTripPct`, `lifeYears` (nye felt i produktdialogen). Mangler gir forsiktige standardverdier merket antatt.
- Tre alternativer med samme «før»: solceller alene, + batteri med grunnstyring, + batteri med smart prisstyring.
  Grunnstyring: lader av overskudd fra sol, dekker eget forbruk, ingen nettlading eller salg. Smartstyring: dynamisk
  programmering kl. 13 hver dag (kjente spotpriser til midnatt neste døgn), persistensprognose for forbruk og sol,
  effektleddet med som tilstand (månedens topp), slitasjekostnad bare i styringen. Planen gjennomføres med virkelige
  verdier: lading ment fra sol hentes ikke fra nett når solen svikter; uventet overskudd lagres og uventet underskudd
  dekkes når det lønner seg etter planens verdi av lagret energi; en effektvakt lader ut når importen blir høyere enn
  planen regnet med og over månedens topp. Samme styring med perfekt prognose vises som referanse.
- Lade- og utladeeffekt kan være forskjellige. Delt hybridinverter: sol og batteriutlading kan til sammen ikke levere mer
  enn hybridinverterens AC-effekt, og lading fra nett går gjennom den.
- Én energibalanse per time: kapasitet, nødstrømsreserve, effekt, tur-retur-virkningsgrad, hjelpelast, eksport- og
  importgrense. Nettstrøm via batteriet telles ikke som egenbruk av sol. Elavgift betales på ladestrøm fra nett.
  Start på reservenivå; gjenværende energi ved periodens slutt krediteres til siste times pris.
- Økonomi per alternativ: batteriinvestering, smartstyringsgebyr (år/engang), batteribytte etter levetid, aldring per år
  (ny kapasitet etter bytte). Batterialternativene regnes for utvalgte år (1, 5, 10 … og rundt bytteåret) og interpoleres.

## Periode, oppløsning og avtaler
- Periode: helt år, hittil i år eller egendefinert fra–til (inntil 12 måneder, også over årsskiftet). 12 måneder gir
  levetidsøkonomi; kortere perioder vises som de er. Profiler, ladeprofil og PVGIS legges på hvert kalenderår i perioden.
- Kvarter: med kvartersforbruk og kvartersavregning regnes alt per kvarter (kvarterspriser der kilden har dem, timepris
  ellers; PVGIS-timer deles likt). Effektleddet måles per time eller per kvarter etter tariffen (`power.resolution`).
- Avtaler: kjøp spot + påslag eller fastpris; salg spot − fradrag eller fastpris, med valgfritt prisgulv.
- Driftstider per dagtype og måneder med redusert drift. Skyggetap per takflate (i tillegg til terrenget i PVGIS).
- Manuelle tariffer: satsendringer i perioden (egne tariffperioder) og måleoppløsning for effekt.
- «Skriv ut / PDF» i resultatet åpner analysen alene for utskrift.

## Lading og flere målere
- Lading: ladepunkter (antall, kW, kWh/dag, ladevindu, dager) gir en ladeprofil som legges til forbruket i alle
  alternativer (ikke hvis den allerede er i forbruksdataene). Viser kWh, andel som kan dekkes av sol og økt effektledd.
- Andre målere: eget forbruk (profil, måneder eller fil per målepunkt) og egen tariff; takflater kobles til en måler.
  Resultatet summeres og vises per måler. Strømavtale og elavgift følger hovedmåleren.

## Antakelser og begrensninger
- Standardprofilene er foreløpige parametere (må kvalitetssikres, gjerne mot Elhub-data og målte kunder).
- PVGIS 6: timeserien hentes fra `/api/v6/power/broadband` (`{"power": [Wh per time]}`, verifisert 29.10.2026;
  `/performance/broadband` gir bare summer). Enkelte timer kan være null og fylles fra nabotimene (maks 48).
  «auto» bruker v6 for værår etter 2023 og faller tilbake til 5.3 (værår 2023, merket som advarsel) hvis v6 feiler.
- Prisområde fra adresse foreslås ut fra fylke og må kontrolleres.
- Filer maks ~4 MB (Vercel-grense for body). Gamle .xls må lagres som .xlsx/.csv. Kvartersforbruk summeres til timer
  (effektleddet regnes per time, slik tariffene er registrert). Kvarterspriser slås sammen til timesnitt.
- Mva.: ja/ukjent = eks. mva., nei = kostnader og investering × 1,25 (salg uten mva.).
- Innmatingstariff, reaktiv effekt, intradag/reservemarkeder, prisgulv i salgsavtaler og skatt er ikke med.

## Gjenstår
Flere tariffer i registeret (Linja 2025 m.fl. – krever tariffark), kvalitetssikring av standardprofilene mot målte
kunder, leverandørenes egne styringsalgoritmer, batteriets produktdata i katalogen.
