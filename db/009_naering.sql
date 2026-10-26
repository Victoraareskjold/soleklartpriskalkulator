-- 009 – næringsanalyse (trinn 1: solceller for næringsbygg)
--
-- Kjøres i Supabase SQL Editor etter 008. Trygg å kjøre flere ganger.
-- Oppretter bare nye tabeller i calc. Endrer ingenting i eksisterende tabeller.
--
-- Datamodellen er laget for hele kravbeskrivelsen: batteri, lading og flere målere
-- kommer som nye målepunkter/utstyr i settings og nye scenarioer, ikke som ombygging.
--  * business_analyses: én analyse per lead (oppgraderes fra standardprofil til målte data)
--  * business_files:    opplastede originalfiler (urørt, med hash). Mapping kan rettes uten ny opplasting.
--  * business_series:   normaliserte tidsserier (UTC, kWh per intervall, Float64 i bytea) med kilde,
--                       status (målt/beregnet/antatt) og datakontroll. Én aktiv per målepunkt og type.
--  * tariffs:           tariffregister (nettselskap, kundegruppe, gyldighet, regel, kilde, sist kontrollert)
--  * spot_prices:       felles spotpriser per prisområde og døgn (rådata fra kilden)
--  * source_cache:      mellomlager for PVGIS og adresseoppslag
--  * business_runs:     beregningskjøringer. Låst kjøring (locked_at) kan ikke endres eller slettes.

begin;

create table if not exists calc.business_analyses (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams(id),
  installer_group_id uuid not null references public.installer_groups(id),
  -- set null (ikke cascade): sletting av lead fungerer, og låste kjøringer beholdes som historikk (som 005)
  lead_id            uuid references public.leads(id) on delete set null,
  settings           jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  lock_version       integer not null default 1,
  created_by         uuid not null references auth.users(id),
  updated_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (lead_id)
);

create table if not exists calc.business_files (
  id           uuid primary key default gen_random_uuid(),
  analysis_id  uuid not null references calc.business_analyses(id) on delete cascade,
  file_name    text not null,
  sha256       text not null,
  size_bytes   integer not null check (size_bytes <= 10485760),
  content      bytea not null,
  detected     jsonb not null,           -- kandidat-serier, metadata, notater
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists business_files_analysis on calc.business_files (analysis_id);

create table if not exists calc.business_series (
  id                 uuid primary key default gen_random_uuid(),
  analysis_id        uuid not null references calc.business_analyses(id) on delete cascade,
  metering_point_id  text not null default 'mp1',
  kind               text not null check (kind in ('forbruk', 'produksjon', 'import', 'eksport', 'pris')),
  origin             text not null,      -- opplasting | pvgis | standardprofil | låst
  status             text not null check (status in ('målt', 'beregnet', 'antatt')),
  resolution_min     smallint not null check (resolution_min in (15, 60)),
  start_utc          timestamptz not null,
  intervals          integer not null,
  sum_kwh            numeric not null,
  values_f64         bytea not null,     -- Float64 little-endian, NaN = mangler
  quality            jsonb,              -- datakontrollen
  provenance         jsonb not null,
  source_file_id     uuid references calc.business_files(id) on delete set null,
  mapping            jsonb,              -- kolonne, enhet, tidskonvensjon som ble bekreftet
  active             boolean not null default true,
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now()
);
create index if not exists business_series_analysis on calc.business_series (analysis_id, metering_point_id, kind) where active;

create table if not exists calc.tariffs (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid references public.teams(id),   -- null = felles for alle
  code           text unique,                        -- stabil nøkkel for innebygde tariffer
  grid_owner     text not null,
  name           text not null,
  customer_group text not null,
  valid_from     date not null,
  valid_to       date,
  definition     jsonb not null,                     -- fastledd, energiledd, effektledd m/ vindu og satsendringer
  source_url     text,
  last_checked   date not null,
  is_manual      boolean not null default false,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

create table if not exists calc.spot_prices (
  price_area  text not null check (price_area in ('NO1', 'NO2', 'NO3', 'NO4', 'NO5')),
  day         date not null,
  rows        jsonb not null,   -- rådata fra kilden (NOK_per_kWh, time_start, time_end …), eks. mva.
  source      text not null,
  fetched_at  timestamptz not null default now(),
  primary key (price_area, day)
);

create table if not exists calc.source_cache (
  key         text primary key,  -- f.eks. pvgis:v5_3:62.47:6.17:t15:a180:l14:2023
  kind        text not null,     -- pvgis | geokode
  response    jsonb not null,
  fetched_at  timestamptz not null default now()
);

create table if not exists calc.business_runs (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references calc.business_analyses(id),
  quote_version_id  uuid references calc.quote_versions(id),
  estimate_id       uuid references public.estimates(id) on delete set null,
  engine_version    text not null,
  input_hash        text not null,
  input_snapshot    jsonb not null,  -- innstillinger + ID-er til seriene som ble brukt (låste kopier)
  result            jsonb not null,
  locked_at         timestamptz,
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now()
);
create index if not exists business_runs_analysis on calc.business_runs (analysis_id);

-- Låste kjøringer og seriene de bygger på kan ikke endres eller slettes
create or replace function calc.reject_locked_run() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  -- Som for quote_versions (005): bare estimate_id -> null er lov på en låst kjøring
  if tg_op = 'UPDATE' and old.locked_at is not null and new.estimate_id is null and old.estimate_id is not null
     and (to_jsonb(new) - 'estimate_id') = (to_jsonb(old) - 'estimate_id') then
    return new;
  end if;
  if old.locked_at is not null then
    raise exception 'Kjøringen er låst til et sendt tilbud. Lag en ny.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists business_runs_locked on calc.business_runs;
create trigger business_runs_locked before update or delete on calc.business_runs
  for each row execute function calc.reject_locked_run();

create or replace function calc.reject_series_value_change() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  -- Bare «active» kan endres. Verdiene i en serie er faste.
  if new.values_f64 is distinct from old.values_f64 or new.start_utc is distinct from old.start_utc
     or new.kind is distinct from old.kind or new.status is distinct from old.status then
    raise exception 'Tidsserier endres ikke. Last opp eller beregn en ny.';
  end if;
  return new;
end $$;
drop trigger if exists business_series_immutable on calc.business_series;
create trigger business_series_immutable before update on calc.business_series
  for each row execute function calc.reject_series_value_change();

drop trigger if exists touch_updated_at on calc.business_analyses;
create trigger touch_updated_at before update on calc.business_analyses
  for each row execute function calc.touch_updated_at();

-- Første tariff: Linja (tidl. Mørenett), prioritert lavspent forbruk > 100 000 kWh, 2024.
-- Satsendringen fra 1.7.2024 er avledet fra Ålesund-kostnadsrapporten og må bekreftes mot tariffarket.
insert into calc.tariffs (code, grid_owner, name, customer_group, valid_from, valid_to, definition, source_url, last_checked)
values (
  'linja-2024-lavspent-over-100k',
  'Linja AS (tidl. Mørenett)',
  'Prioritert lavspent forbruk over 100 000 kWh',
  'Næring lavspent > 100 MWh',
  '2024-01-01', '2024-12-31',
  $json${
    "fixedNokPerYear": 8800,
    "fixedAllocation": "per_dag",
    "energyOrePerKwh": 7.2,
    "power": {
      "method": "maks_time_i_vindu",
      "window": { "weekdays": [1, 2, 3, 4, 5], "fromHour": 6, "toHour": 23, "excludeHolidays": true },
      "summerMonths": [4, 5, 6, 7, 8, 9],
      "summerNokPerKwMonth": 31,
      "winterNokPerKwMonth": 68
    },
    "rateChanges": [
      { "from": "2024-07-01", "summerNokPerKwMonth": 35, "winterNokPerKwMonth": 77,
        "source": "Avledet fra kostnadsrapporten 2024 (alle tre målere, juli–desember). Ikke bekreftet i tariffark.",
        "status": "beregnet" }
    ],
    "notes": [
      "Fastledd inkl. Enova-påslag 800 kr/år – legges ikke til igjen.",
      "Sommer = april–september.",
      "Helligdager holdes utenfor effektvinduet (stemmer med kostnadsrapporten for april 2024).",
      "Innmatingstariff for eksport er ikke med."
    ]
  }$json$::jsonb,
  'https://cdn.sanity.io/files/zg947p2r/production/19fdaa8dbfba0dd59d6b63fdd462787d87091537.pdf',
  '2026-10-21'
)
on conflict (code) do nothing;

-- Samme tilgangsmodell som resten av calc: bare tjenesten (service role)
do $$
declare t text;
begin
  foreach t in array array['business_analyses', 'business_files', 'business_series', 'tariffs', 'spot_prices', 'source_cache', 'business_runs'] loop
    execute format('alter table calc.%I enable row level security', t);
    execute format('revoke all on calc.%I from anon, authenticated', t);
    execute format('grant all on calc.%I to service_role', t);
  end loop;
end $$;
revoke all on function calc.reject_locked_run() from anon, authenticated, public;
revoke all on function calc.reject_series_value_change() from anon, authenticated, public;

commit;
