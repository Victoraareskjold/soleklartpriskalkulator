-- 007: Foretrukne merker/leverandører og standard batterioppsett (Asbjørns merknader 18.10.2026)
-- Trygg å kjøre flere ganger. Kjøres etter 006.

alter table calc.settings
  -- {"inverter"|"hybrid"|"panel"|"battery": {"supplierIds": [uuid], "brands": ["Solis"]}}
  add column if not exists preferences jsonb not null default '{}'::jsonb,
  -- {"offerEnabled": true, "models": [produkt-id i rekkefølge]}
  add column if not exists battery_defaults jsonb not null default '{}'::jsonb;
