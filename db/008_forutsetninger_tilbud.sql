-- 008: Forutsetningene i tilbudets økonomiberegning (Asbjørns merknader 19.10.2026)
-- Strømpris, nettleie og prisvekst ligger allerede i egne kolonner (006).
-- Her: salgspris for overskudd, egenbruk, degradering, inverterbytte, drift, standard årsforbruk og periode.
-- Trygg å kjøre flere ganger. Kjøres etter 007.

alter table calc.settings
  add column if not exists offer_assumptions jsonb not null default '{}'::jsonb;
