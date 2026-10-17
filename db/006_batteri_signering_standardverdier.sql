-- 006 – batteritillegg, signering og standardverdier for tilbud
--
-- Kjøres i Supabase SQL Editor etter 005.
--  * calc.settings: standard batteritype (HV/LV), hvor mye PV en hybridinverter tåler per kW AC,
--    og standardverdier for økonomien i tilbudet (strømpris, nettleie, prisvekst).
--  * public.estimates: kundens endelige valg og prisoppstilling ved signering (låses sammen med
--    signed_at). Bare nye, valgfrie kolonner – eksisterende estimater påvirkes ikke.

begin;

alter table calc.settings
  add column if not exists default_battery_class text not null default 'HV' check (default_battery_class in ('HV', 'LV')),
  add column if not exists hybrid_dc_ratio numeric(6,3) not null default 1.5 check (hybrid_dc_ratio > 0 and hybrid_dc_ratio <= 5),
  add column if not exists economy_el_price_private numeric(8,4) not null default 0.56,
  add column if not exists economy_net_price_private numeric(8,4) not null default 0.62,
  add column if not exists economy_el_price_business numeric(8,4) not null default 0.56,
  add column if not exists economy_net_price_business numeric(8,4) not null default 0.62,
  add column if not exists economy_price_growth_percent numeric(6,3) not null default 2.5;

alter table public.estimates
  add column if not exists signed_selection jsonb,
  add column if not exists signed_offer jsonb;

commit;
