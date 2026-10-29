# Næringsanalyse – trinn 1 (solceller for næringsbygg)

Første testversjon av Asbjørns kravbeskrivelse (18.10.2026) med presiseringer (21.10.2026).

## Flyt
1. Dashboardet (lead → «Opprett estimat», næringskunde) viser panelet «Næringsanalyse». Analysen opprettes per lead
   (`calc.business_analyses`) og lagres fortløpende.
2. Selger velger virksomhetstype, driftstid, periode (helt år eller hittil i år), forbruk (årsforbruk, månedsforbruk eller
   målte timer fra fil), takflater (fra solkartet), tariff, avtaler og økonomiske forutsetninger.
3. «Beregn med lagret grunnlag» / «Hent oppdaterte kildedata» kjører motoren (`POST /api/business/[id]/run`).
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

## Antakelser og begrensninger i trinn 1
- Standardprofilene er foreløpige parametere (må kvalitetssikres, gjerne mot Elhub-data og målte kunder).
- PVGIS 6: timeserien hentes fra `/api/v6/power/broadband` (`{"power": [Wh per time]}`, verifisert 29.10.2026;
  `/performance/broadband` gir bare summer). Enkelte timer kan være null og fylles fra nabotimene (maks 48).
  «auto» bruker v6 for værår etter 2023 og faller tilbake til 5.3 (værår 2023, merket som advarsel) hvis v6 feiler.
- Prisområde fra adresse foreslås ut fra fylke og må kontrolleres.
- Filer maks ~4 MB (Vercel-grense for body). Gamle .xls må lagres som .xlsx/.csv. Kvartersforbruk regnes ikke ennå.
- Ett målepunkt beregnes. Datamodellen har målepunkt-ID på serier og innstillinger for flere.
- Innmatingstariff, reaktiv effekt, mva.-fradrag og skatt er ikke med.

## Gjenstår (neste runder)
Batteri (trinn 2), lading og flere målere (trinn 3), kvartersdata, egendefinert periode (f.eks. 14.3.–13.3.),
flere tariffer i registeret, kvalitetssikring av profiler, PDF, bakgrunnsjobb for store simuleringer.
