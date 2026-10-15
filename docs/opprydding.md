# Opprydding etter bytte

Gjøres **helt til slutt**, når ny kalkulator er i drift og godkjent etter parallellkjøring.
Ta backup (eksport) av hver tabell før den droppes. Basert på eksport 14.10.2026 og kodesøk i soleklartdashboard, pvwebsites og pvmap.

## 1. Tabeller som erstattes av `calc` og kan droppes

Brukes bare av dagens priskalkulator/pristabell i dashboardet.

| Tabell | Rader | Erstattes av |
|---|---|---|
| `suppliers` | 6 | `calc.suppliers` |
| `product_categories` | 8 | `calc.categories` |
| `product_subcategories` | 11 | `calc.categories` (underkategori) |
| `products` | 149 | `calc.products` + `calc.supplier_price_versions` |
| `supplier_categories` | 49 | påslag per kategori i `calc.price_book_entries` |
| `mount_items` | 122 | monteringspris per installatør/produkt/taktype i prisbok |
| `mount_volume_reduction` | 32 | `calc.volume_tiers` |
| `electrical_installation_categories` | 4 | `calc.work_types` |
| `electrical_installation_items` | 132 | `calc.work_types` + satser i prisbok |
| `team_commission` | 4 | `calc.commission_policies` / `commission_tiers` |
| `work_items` | 0 | død, ingen kode bruker den |

## 2. Brukes av pvmap. Kan IKKE droppes uten videre

pvmap (solkartet) har sitt eget grove prisestimat til kunden og leser:

| Tabell / felt | Brukt i pvmap |
|---|---|
| `solarpanels` (2 rader) | `api/panel-types` → panelvalg i kartet |
| `commissions` (1 rad) | `api/commission`, `api/pricing-data` |
| `installer_groups.FORMEL`, `"0-72"` … `"1000+"` | `api/pricing-data` |
| `roof_types.PRIS` | `api/roof-types` |

Disse kan først fjernes hvis pvmap-estimatet også flyttes til ny tjeneste (avklares med Asbjørn). Til da blir de stående.

## 3. Beholdes

- `roof_types` (14 rader): `leads.roof_type_id` peker hit (leads, cold calling, pvmap). Den er lead-data, ikke bare prisdata. `calc` refererer til disse ID-ene. Bare `PRIS`-kolonnen kan fjernes når pvmap ikke trenger den.
- `estimates.price_data`: leses av dashboard og pvwebsites. Ny tjeneste skriver fortsatt dette formatet. Ny kolonne `estimates.quote_version_id`.
- `installer_groups` selv: brukes overalt. Bare prisfeltene i punkt 2 er kandidater.

## 4. Kode som skal bort i soleklartdashboard

- `app/components/price-calculator/**` (alle filer)
- `app/dashboard/pricetable/page.tsx`
- `app/api/price_table/**`
- `lib/db/price_tables.ts`
- Kalkulator-delen av `app/components/leads/EstimateSection.tsx`
- Typer i `types/price_table.ts` utenom `PriceOverview`/`PriceLineItem` (brukes av `price_data`)

## 5. Sikkerhet (gjøres før live, ikke til slutt)

- `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` finnes i soleklartdashboard og pvmap (`utils/supabase/client.*`). Gi nytt navn `SUPABASE_SERVICE_ROLE_KEY`, bruk kun server-side, og roter nøkkelen i Supabase.
- Rettet i soleklart-kalkulator sin `.env` 14.10.
