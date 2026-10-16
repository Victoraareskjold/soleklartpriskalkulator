-- 005 – estimater (og leads) kan slettes igjen
--
-- Problem: calc.calculations.estimate_id og calc.quote_versions.estimate_id peker på
-- public.estimates uten ON DELETE. I tillegg stopper triggeren quote_versions_immutable
-- alle endringer på låste versjoner. Resultat: DELETE på et estimat som er laget med den
-- nye kalkulatoren feiler med fremmednøkkelfeil (og sletting av lead feiler på lead_id).
--
-- Løsning:
--   * fremmednøklene får ON DELETE SET NULL. Kalkylen og den låste versjonen beholdes
--     som historikk, bare koblingen til det slettede estimatet/leaden fjernes.
--   * triggeren slipper gjennom én type endring: at estimate_id settes til null.
--     Alt annet i en låst versjon er fortsatt uforanderlig, og DELETE er fortsatt stoppet.
--
-- Kjøres i Supabase SQL Editor.

begin;

-- Finner og bytter ut fremmednøkkelen uansett hva den heter
create or replace function pg_temp.set_null_fk(tbl regclass, col text, ref regclass) returns void
language plpgsql as $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.contype = 'f' and con.conrelid = tbl and con.confrelid = ref and att.attname = col
  loop
    execute format('alter table %s drop constraint %I', tbl, c.conname);
  end loop;
  execute format(
    'alter table %s add constraint %I foreign key (%I) references %s(id) on delete set null',
    tbl, replace(tbl::text, 'calc.', '') || '_' || col || '_fkey', col, ref
  );
end $$;

select pg_temp.set_null_fk('calc.calculations', 'estimate_id', 'public.estimates');
select pg_temp.set_null_fk('calc.calculations', 'lead_id', 'public.leads');
select pg_temp.set_null_fk('calc.quote_versions', 'estimate_id', 'public.estimates');

-- Låste versjoner: bare estimate_id -> null er lov
create or replace function calc.reject_quote_version_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE'
     and new.estimate_id is null
     and old.estimate_id is not null
     and (to_jsonb(new) - 'estimate_id') = (to_jsonb(old) - 'estimate_id') then
    return new;
  end if;
  raise exception 'Tilbudsversjoner er låst. Lag en ny versjon.';
end $$;

drop trigger if exists quote_versions_immutable on calc.quote_versions;
create trigger quote_versions_immutable
  before update or delete on calc.quote_versions
  for each row execute function calc.reject_quote_version_mutation();

commit;
