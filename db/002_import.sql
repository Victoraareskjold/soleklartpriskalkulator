-- 002 – import av dagens pristabeller fra public til calc
--
-- Kjøres ÉN gang i Supabase SQL Editor etter 001. Leser bare fra public.
-- Produkter, leverandører og kategorier beholder samme ID som i public.
-- Satser får ny ID, med legacy_id = ID-en i gammel tabell.
-- Ingen prisregler endres. Kjente datafeil importeres som de er og listes i docs/opprydding.md.

begin;

do $$
begin
  if exists (select 1 from calc.products) then
    raise exception 'calc er allerede importert. Avbryter.';
  end if;
  if (select count(*) from public.teams) <> 1 then
    raise exception 'Forventet nøyaktig ett team i public.teams.';
  end if;
end $$;

-- Hjelpetabell: alt importeres til det ene teamet
create temp table import_team on commit drop as select id from public.teams;

-- Leverandører
insert into calc.suppliers (id, team_id, name, sort_order, legacy_id)
select s.id, t.id, s.name, coalesce(s.index, 0)::int, s.id
from public.suppliers s cross join import_team t;

-- Hovedkategorier
insert into calc.categories (id, team_id, name, product_kind, markup_group, sort_order, legacy_id)
select c.id, t.id, c.name,
  case c.name
    when 'solcellepanel' then 'panel'
    when 'feste'         then 'feste'
    when 'inverter'      then 'inverter'
    when 'batteri'       then 'batteri'
    when 'frakt'         then 'frakt'
    when 'stillase'      then 'stillase'
    when 'ballastein'    then 'ballastein'
    else 'annet'
  end::calc.product_kind,
  case c.name
    when 'frakt'      then 'frakt'
    when 'stillase'   then 'stillase'
    when 'ballastein' then 'ballastein'
    else 'solcellemateriell'
  end::calc.markup_group,
  coalesce(c.index, 99)::int, c.id
from public.product_categories c cross join import_team t;

-- Underkategorier (arver type og påslagsgruppe fra hovedkategorien)
insert into calc.categories (id, team_id, parent_id, name, product_kind, markup_group, sort_order, legacy_id)
select sc.id, p.team_id, p.id, sc.name, p.product_kind, p.markup_group, coalesce(sc.index, 99)::int, sc.id
from public.product_subcategories sc
join calc.categories p on p.id = sc.category_id;

-- Produkter. Kategori = underkategori hvis den finnes.
insert into calc.products (id, team_id, supplier_id, category_id, name, unit, price_ore,
                           price_updated_at, attachment_url, legacy_id)
select p.id, t.id, p.supplier_id, coalesce(p.subcategory_id, p.category_id), trim(p.name),
  case when c.name = 'feste' then 'panel' else 'stk' end,
  round(p.price_ex_vat * 100)::bigint,
  p.updated_at, p.attachment, p.id
from public.products p
join public.product_categories c on c.id = p.category_id
cross join import_team t;

-- Felles arbeidstyper. Navn trimmes og «Delevis backup» slås sammen med «Delvis backup».
-- Enhetene er foreslått ut fra navnet (unit_confirmed = false til de er bekreftet).
create temp table work_units (name text primary key, unit text) on commit drop;
insert into work_units values
  ('Delvis backup', 'system'), ('Full backup', 'system'), ('Uten backup', 'system'), ('Pylotech H3', 'system'),
  ('Dokumentasjon', 'jobb'), ('Melding til nettselskap', 'jobb'),
  ('Føring fra tak til inverter', 'inverter'), ('Sikring+opplegg til inverter', 'inverter'),
  ('DC kabler i kanal pr.m', 'm'), ('DC kabler i kanal på vegg (utover 5m)*', 'm'),
  ('DC kabler i rør lagt i ferdig grøft. (pr.m)*', 'm'), ('Tilførselskabel til inverter utover 15m', 'm'),
  ('Overspenningsvern ferdig montert', 'jobb'),
  ('Tillegg for gjennomføring betongvegg pr. hull. (opp til 25mm. Ikke kjerneborring)', 'hull'),
  ('Tillegg for gjennomføring murvegg/leca pr. hull. (opp til 25mm. Ikke kjerneborring)', 'hull'),
  ('Tillegg for jobbing på bratte tak (Over 35°)', 'jobb'),
  ('Tillegg for paneler på flere bygninger*', 'jobb'),
  ('Tillegg for takstein som er skrudd. (pr.panel)', 'panel');

create temp table work_src on commit drop as
select i.id, i.installer_group_id, i.price_per,
  case ec.name when 'tilleggskostnader' then 'tillegg' else ec.name end as grp,
  case trim(i.name) when 'Delevis backup' then 'Delvis backup' else trim(i.name) end as name
from public.electrical_installation_items i
join public.electrical_installation_categories ec on ec.id = i.category_id;

do $$
declare missing text;
begin
  select string_agg(distinct s.name, ', ') into missing
  from work_src s left join work_units u on u.name = s.name where u.name is null;
  if missing is not null then
    raise exception 'Arbeidstyper uten enhet: %', missing;
  end if;
end $$;

insert into calc.work_types (team_id, grp, name, unit, unit_confirmed, sort_order)
select t.id, w.grp, w.name, u.unit, false,
  row_number() over (partition by w.grp order by w.name)::int
from (select distinct grp, name from work_src) w
join work_units u on u.name = w.name
cross join import_team t;

insert into calc.installer_work_rates (installer_group_id, work_type_id, price_ore, legacy_id)
select s.installer_group_id, wt.id, round(s.price_per * 100)::bigint, s.id
from work_src s
join calc.work_types wt on wt.grp = s.grp and wt.name = s.name;

-- Påslag per installatør. Raden uten gyldig installatør hoppes over.
insert into calc.installer_markups (installer_group_id, markup_group, percent)
select sc.installer_group_id,
  case sc.name when 'elektrisk installasjon' then 'elektro' else sc.name end::calc.markup_group,
  sc.markup_percentage
from public.supplier_categories sc
join public.installer_groups g on g.id = sc.installer_group_id;

-- Montering per installatør og taktype
insert into calc.installer_mount_rates (installer_group_id, roof_type_id, product_id, price_ore, legacy_id)
select m.installer_group_id, m.roof_type_id, m.product_id, round(m.price_per * 100)::bigint, m.id
from public.mount_items m;

-- Volumrabatt (som den er, også Testelektro med overlapp)
insert into calc.volume_tiers (installer_group_id, from_panels, to_panels, percent, legacy_id)
select v.installer_group_id, v.amount::int, v.amount2::int, v.reduction, v.id
from public.mount_volume_reduction v;

-- Provisjon. Gamle grenser (0–55, 55–200, 200–500, 500+) normalisert til
-- 1–55, 56–200, 201–500, 501+ som godkjent i prototypen.
insert into calc.commission_tiers (team_id, from_panels, to_panels, percent)
select c.team_id,
  case when c.amount = 0 then 1 else c.amount::int + 1 end,
  c.amount2::int, c.commission
from public.team_commission c;

insert into calc.settings (team_id) select id from import_team;

commit;

-- Kontroll etterpå (kjør gjerne separat):
-- select 'suppliers' t, count(*) from calc.suppliers union all
-- select 'categories', count(*) from calc.categories union all
-- select 'products', count(*) from calc.products union all
-- select 'work_types', count(*) from calc.work_types union all
-- select 'work_rates', count(*) from calc.installer_work_rates union all
-- select 'markups', count(*) from calc.installer_markups union all
-- select 'mount_rates', count(*) from calc.installer_mount_rates union all
-- select 'volume_tiers', count(*) from calc.volume_tiers union all
-- select 'commission_tiers', count(*) from calc.commission_tiers;
