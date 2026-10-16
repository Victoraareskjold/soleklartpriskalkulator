-- 004 – selvbetjening: påslagsgrupper, kategoriroller, produktdata og beregningsregler
--
-- Kjøres i Supabase SQL Editor etter 003. Endrer bare schema calc.
-- Produktdata (Wp, kW, nett, hybrid, batteritype, kWh) utledes fra produkt- og kategorinavn og
-- merkes "derived": true. De må kontrolleres i produktkatalogen.

begin;

-- 1. Påslagsgrupper blir en tabell, så nye grupper (f.eks. "DC-ladere") kan opprettes i UI-et
create table calc.markup_groups (
  team_id    uuid not null references public.teams(id),
  code       text not null check (code ~ '^[a-z0-9æøå_-]+$'),
  name       text not null,
  sort_order integer not null default 0,
  primary key (team_id, code)
);

insert into calc.markup_groups (team_id, code, name, sort_order)
select t.id, g.code, g.name, g.sort_order
from public.teams t
cross join (values
  ('solcellemateriell', 'Solcellemateriell', 1),
  ('frakt', 'Frakt', 2),
  ('stillase', 'Stillase', 3),
  ('ballastein', 'Ballastein', 4),
  ('elektro', 'Elektrisk installasjon', 5),
  ('montering', 'Montering', 6)
) as g(code, name, sort_order);

alter table calc.categories alter column markup_group type text using markup_group::text;
alter table calc.installer_markups alter column markup_group type text using markup_group::text;
drop type calc.markup_group;

alter table calc.categories
  add constraint categories_markup_group_fkey
  foreign key (team_id, markup_group) references calc.markup_groups (team_id, code);

-- 2. Regler per kategori
--    quantity_rule: per_panel = mengden følger panelantallet (feste). manual = settes for hånd.
--    support_eligible: kostnaden regnes med i grunnlaget for solcellestøtte (Enova).
alter table calc.categories
  add column quantity_rule text not null default 'manual' check (quantity_rule in ('manual', 'per_panel')),
  add column support_eligible boolean not null default false;

update calc.categories set quantity_rule = 'per_panel' where product_kind = 'feste';
update calc.categories set support_eligible = true
where product_kind in ('panel', 'feste', 'inverter', 'frakt', 'stillase', 'ballastein');

alter table calc.work_types
  add column support_eligible boolean not null default true;
update calc.work_types set support_eligible = false where grp = 'batteri';

-- 3. Sentrale beregningsregler
alter table calc.settings
  add column inverter_sizing_factor numeric(6,3) not null default 1.2 check (inverter_sizing_factor > 0 and inverter_sizing_factor <= 5),
  add column support_name text not null default 'Enova',
  add column support_enabled boolean not null default true,
  add column support_percent numeric(9,4) not null default 25 check (support_percent between 0 and 100),
  add column support_per_kwp_ore bigint not null default 250000 check (support_per_kwp_ore >= 0),
  add column support_max_kwp numeric(9,3) not null default 15 check (support_max_kwp >= 0),
  add column support_max_ore bigint not null default 3750000 check (support_max_ore >= 0),
  add column mount_support_eligible boolean not null default true;

-- 4. Produktdata utledet fra navn (må kontrolleres)
create temp table derived on commit drop as
select p.id,
       c.product_kind,
       upper(coalesce(c.name, '') || ' ' || coalesce(parent.name, '')) as cat,
       p.name
from calc.products p
join calc.categories c on c.id = p.category_id
left join calc.categories parent on parent.id = c.parent_id;

-- Paneler: Wp
update calc.products p
set specs = p.specs || jsonb_build_object('wp', substring(d.name from '(\d{3,4})\s*W')::int, 'derived', true)
from derived d
where d.id = p.id and d.product_kind = 'panel' and substring(d.name from '(\d{3,4})\s*W') is not null;

-- Invertere: AC-effekt, nett, faser, hybrid, batteritype
update calc.products p
set specs = p.specs || jsonb_strip_nulls(jsonb_build_object(
  'acKw', replace(substring(d.name from '(\d+(?:[.,]\d+)?)\s*kW'), ',', '.')::numeric,
  'grid', case when d.cat like '%400V%' then '400' when d.cat like '%230V%' or d.cat like '%1 FAS%' then '230' end,
  'phases', case when d.cat like '%1 FAS%' or d.name ~* '1[ -]?fas' then 1 else 3 end,
  'hybrid', (d.cat like '%HYBRID%' or d.name ~* 'hybrid'),
  'batteryClass', case when d.cat like '%HYBRID HV%' then 'HV' when d.cat like '%HYBRID LV%' then 'LV' end,
  'derived', true))
from derived d
where d.id = p.id and d.product_kind = 'inverter';

-- Batterier: HV/LV og kapasitet
update calc.products p
set specs = p.specs || jsonb_strip_nulls(jsonb_build_object(
  'batteryClass', case when d.cat like '%HV%' then 'HV' when d.cat like '%LV%' then 'LV' end,
  'capacityKwh', replace(substring(d.name from '(\d+(?:[.,]\d+)?)\s*kW'), ',', '.')::numeric,
  'derived', true))
from derived d
where d.id = p.id and d.product_kind = 'batteri';

-- 5. Hvem som opprettet/endret utkast vises i utkastlisten
alter table calc.calculations add column updated_by uuid references auth.users(id);

grant all on calc.markup_groups to service_role;
alter table calc.markup_groups enable row level security;

commit;

-- Kontroll:
-- select c.name, p.name, p.specs from calc.products p join calc.categories c on c.id = p.category_id
-- where c.product_kind in ('panel','inverter','batteri') order by 1, 2;
