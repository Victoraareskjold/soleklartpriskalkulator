-- 001 – schema `calc` for ny priskalkulator
--
-- Kjøres i Supabase SQL Editor (prod). Oppretter kun nye objekter i `calc`.
-- Endrer, sletter eller låser INGENTING i `public`.
--
-- Prinsipper:
--  * Gjenbruker public.teams, public.installer_groups, public.roof_types og public.leads/estimates
--    i stedet for å lage egne kopier. Én sannhet for hvem som er installatør.
--  * Tilgang styres av API-et (sjekker token + public.team_members). Nettleseren leser/skriver
--    aldri calc direkte: RLS er på uten policies, og anon/authenticated har ingen rettigheter.
--  * Beløp i hele øre (bigint). Prosent som numeric.
--  * Katalog og satser kan redigeres. Historikk sikres ved at hver tilbudsversjon lagrer en
--    låst kopi av alt den ble regnet med (quote_versions er append-only).
--  * legacy_id peker på raden i dagens public-tabell den kom fra (for import og avstemming).

begin;

create schema if not exists calc;

-- ---------------------------------------------------------------------------
-- Felles katalog (per team)
-- ---------------------------------------------------------------------------

-- Påslagsgruppe: avgjør hvilket påslag en linje får hos installatøren.
-- solcellemateriell = panel, inverter, feste, batteri.
create type calc.markup_group as enum (
  'solcellemateriell', 'frakt', 'stillase', 'ballastein', 'elektro', 'montering'
);

-- Teknisk type. 'panel' teller med i panelantall og provisjonstrinn.
create type calc.product_kind as enum (
  'panel', 'feste', 'inverter', 'batteri', 'frakt', 'stillase', 'ballastein', 'annet'
);

create table calc.suppliers (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id),
  name        text not null,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  legacy_id   uuid unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (team_id, name)
);

create table calc.categories (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id),
  parent_id     uuid references calc.categories(id),
  name          text not null,
  product_kind  calc.product_kind not null,
  markup_group  calc.markup_group not null,
  sort_order    integer not null default 0,
  legacy_id     uuid unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on calc.categories (team_id);

create table calc.products (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id),
  supplier_id     uuid not null references calc.suppliers(id),
  category_id     uuid not null references calc.categories(id),
  name            text not null,
  unit            text not null default 'stk',
  price_ore       bigint not null check (price_ore >= 0),   -- innkjøp eks. mva.
  price_updated_at timestamptz not null default now(),
  attachment_url  text,                                      -- datablad
  -- Tekniske egenskaper (effekt, kWh, faser …). Brukes senere til automatisk utstyrsvalg.
  specs           jsonb not null default '{}' check (jsonb_typeof(specs) = 'object'),
  active          boolean not null default true,
  legacy_id       uuid unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id)
);
create index on calc.products (team_id, category_id);

-- Felles arbeidstyper. Satsen avtales per installatør (installer_work_rates).
create table calc.work_types (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id),
  grp         text not null check (grp in ('søknad', 'solcelleanlegg', 'batteri', 'tillegg')),
  name        text not null,
  unit        text not null,                                 -- jobb, inverter, system, m, hull, panel
  unit_confirmed boolean not null default false,             -- enhet gjettet ved import til den er bekreftet
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (team_id, grp, name)
);

-- ---------------------------------------------------------------------------
-- Avtaler per installatør (public.installer_groups)
-- ---------------------------------------------------------------------------

create table calc.installer_markups (
  installer_group_id uuid not null references public.installer_groups(id),
  markup_group       calc.markup_group not null,
  percent            numeric(9,4) not null check (percent between 0 and 1000),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id),
  primary key (installer_group_id, markup_group)
);

create table calc.installer_work_rates (
  id                 uuid primary key default gen_random_uuid(),
  installer_group_id uuid not null references public.installer_groups(id),
  work_type_id       uuid not null references calc.work_types(id),
  price_ore          bigint not null check (price_ore >= 0),
  legacy_id          uuid unique,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id),
  unique (installer_group_id, work_type_id)
);

-- Montering: pris per panel for installatør + taktype, med festeproduktet som brukes.
create table calc.installer_mount_rates (
  id                 uuid primary key default gen_random_uuid(),
  installer_group_id uuid not null references public.installer_groups(id),
  roof_type_id       uuid not null references public.roof_types(id),
  product_id         uuid references calc.products(id),      -- festesystem
  price_ore          bigint not null check (price_ore >= 0), -- per panel
  legacy_id          uuid unique,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id),
  unique (installer_group_id, roof_type_id)
);

-- Volumrabatt på monteringsgrunnlaget. Overlapp/hull kontrolleres av motoren og API-et.
create table calc.volume_tiers (
  id                 uuid primary key default gen_random_uuid(),
  installer_group_id uuid not null references public.installer_groups(id),
  from_panels        integer not null check (from_panels >= 0),
  to_panels          integer check (to_panels is null or to_panels >= from_panels), -- null = ingen øvre grense
  percent            numeric(9,4) not null check (percent between 0 and 100),
  legacy_id          uuid unique,
  unique (installer_group_id, from_panels)
);

-- ---------------------------------------------------------------------------
-- Soleklart-innstillinger (per team)
-- ---------------------------------------------------------------------------

create table calc.settings (
  team_id                     uuid primary key references public.teams(id),
  no_panel_commission_percent numeric(9,4) not null default 25 check (no_panel_commission_percent between 0 and 100),
  vat_percent                 numeric(9,4) not null default 25 check (vat_percent between 0 and 100),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users(id)
);

create table calc.commission_tiers (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id),
  from_panels integer not null check (from_panels >= 1),
  to_panels   integer check (to_panels is null or to_panels >= from_panels),
  percent     numeric(9,4) not null check (percent between 0 and 100),
  unique (team_id, from_panels)
);

-- ---------------------------------------------------------------------------
-- Kalkyler og låste tilbudsversjoner
-- ---------------------------------------------------------------------------

-- Arbeidsutkast. Ett per lead/estimat. Kan endres fritt; lock_version hindrer at to
-- som redigerer samtidig overskriver hverandre.
create table calc.calculations (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams(id),
  installer_group_id uuid not null references public.installer_groups(id),
  lead_id            uuid references public.leads(id),
  estimate_id        uuid references public.estimates(id),
  title              text not null,
  customer_type      text not null default 'private' check (customer_type in ('private', 'business')),
  draft_input        jsonb not null check (jsonb_typeof(draft_input) = 'object'),
  lock_version       integer not null default 1,
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on calc.calculations (lead_id);
create index on calc.calculations (installer_group_id);

-- Låst versjon. Serveren regner på nytt før lagring. Kan aldri endres eller slettes.
create table calc.quote_versions (
  id                uuid primary key default gen_random_uuid(),
  calculation_id    uuid not null references calc.calculations(id),
  version           integer not null check (version > 0),
  parent_version_id uuid references calc.quote_versions(id),
  estimate_id       uuid references public.estimates(id),
  engine_version    text not null,
  input             jsonb not null,   -- motorens input (med alle priser slik de var)
  result            jsonb not null,   -- motorens resultat
  total_ex_vat_ore  bigint not null,
  total_inc_vat_ore bigint not null,
  idempotency_key   text unique,      -- samme lagring sendt to ganger gir én versjon
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now(),
  unique (calculation_id, version)
);
create index on calc.quote_versions (estimate_id);

create function calc.reject_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Tilbudsversjoner er låst. Lag en ny versjon.';
end $$;

create trigger quote_versions_immutable
  before update or delete on calc.quote_versions
  for each row execute function calc.reject_mutation();

-- updated_at holdes oppdatert automatisk
create function calc.touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'suppliers', 'categories', 'products', 'work_types', 'installer_markups',
    'installer_work_rates', 'installer_mount_rates', 'settings', 'calculations'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on calc.%I for each row execute function calc.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Tilgang: kun service role (via tjenestens API)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'calc' loop
    execute format('alter table calc.%I enable row level security', t);
  end loop;
end $$;

revoke all on schema calc from anon, authenticated;
revoke all on all tables in schema calc from anon, authenticated;
revoke all on all functions in schema calc from anon, authenticated, public;
grant usage on schema calc to service_role;
grant all on all tables in schema calc to service_role;
alter default privileges in schema calc grant all on tables to service_role;

commit;
