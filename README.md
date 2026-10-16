# Soleklart kalkulator

Egen tjeneste for priskalkulering av solcelleanlegg. Erstatter priskalkulatoren og `/dashboard/pricetable` i soleklartdashboard.

- **Kun API**, ingen egen nettside. Dashboardet (og senere andre) kaller tjenesten med brukerens Supabase-token.
- **UI** (kalkulator per lead og prisoppsett for Asbjørn) bygges som React-sider i soleklartdashboard og snakker med dette API-et.
- **Database**: samme Supabase-prosjekt som dashboardet, eget schema `calc` (`db/001_calc_schema.sql`, `db/002_import.sql`). Tilgang via direkte Postgres-tilkobling server-side.

Fasit for utseende og regning er prototypen `soleklart-kalkulator-v1` (HTML + tester).

## Kommandoer

```bash
bun install
bun dev          # http://localhost:4100
bun run test     # regnemotorens fasittester
bun run typecheck
bun run lint
```

## API

Alle kall krever `Authorization: Bearer <Supabase access token>`. Tilgang hentes fra `public.team_members`:
admin/member ser alle installatører i teamet, installatør bare sin egen. Beløp i øre.

| Metode | Sti | Hva |
|---|---|---|
| GET | `/api/installers` | Installatører brukeren har tilgang til |
| GET | `/api/catalog?installerGroupId=` | Katalog, påslag, arbeids-/monteringssatser, volum- og provisjonstrinn |
| POST | `/api/calculate` | Forhåndsberegning av en ferdig bygget kalkyle (ikke autoritativ) |
| GET/POST | `/api/calculations` | Liste (`?leadId=`/`?installerGroupId=`) / nytt utkast |
| GET/PUT | `/api/calculations/[id]` | Utkast + versjoner / lagre utkast (`lockVersion`) |
| POST | `/api/calculations/[id]/versions` | Låst versjon. Header `Idempotency-Key`. Regner på nytt fra DB, skriver `estimates.price_data` + `quote_version_id` hvis kalkylen har estimat |
| GET | `/api/quote-versions/[id]` | Låst versjon med input, resultat og price_data |
| POST | `/api/preview` | Forhåndsvisning av et utkast med samme regler som lagring (kWp, støtte, katalogdata fra DB) |
| — | admin | `products`, `suppliers`, `categories`, `markup-groups`, `work-types`, `installers/[id]/{markups,work-rates,mount-rates,volume-tiers}`, `settings` (provisjon, mva., inverterfaktor, støtteregler) |

## Miljøvariabler

`DATABASE_URL` (transaction pooler), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (offentlig anon-nøkkel, kun for å verifisere token), `CORS_ORIGINS` (kommaseparert, f.eks. `http://localhost:4000`). Ingen service role-nøkkel trengs.

## Struktur

```
lib/engine/   Regnemotor. Ren TypeScript, ingen DB/UI. Alle beløp ut i øre.
app/api/      API-ruter
lib/server/   DB-tilkobling, innlogging/tilgang, CORS og feilhåndtering
db/           SQL: 001 schema, 002 import, 003 estimates.quote_version_id, 004 regler/produktdata
docs/         opprydding.md: hva som slettes til slutt
```

## Regler

- Klienten regner aldri endelig pris. Serveren regner på nytt ved lagring.
- Kunden ser aldri innkjøpspris eller provisjon.
- Fasittallene i `lib/engine/calculate.test.ts` endres ikke uten avklaring med Asbjørn.
# soleklartpriskalkulator
