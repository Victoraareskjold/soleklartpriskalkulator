-- 003 – kobling fra dagens estimater til låste tilbudsversjoner i calc
--
-- Eneste endring i public: én ny, valgfri kolonne. Gamle estimater får null og virker som før.
-- Kjøres i Supabase SQL Editor.

begin;

alter table public.estimates
  add column if not exists quote_version_id uuid references calc.quote_versions(id);

create index if not exists estimates_quote_version_id_idx on public.estimates (quote_version_id);

commit;
