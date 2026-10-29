-- 010 – næringsanalyse: administrasjon av tariffer (arkivering, kopier) og presisering av Linja 2024
--
-- Kjøres etter 009. Trygg å kjøre flere ganger.
--  * archived_at: tariffen vises ikke for nye valg, men analyser og sendte tilbud som bruker den beholdes.
--    Sletting er bare lov for egne tariffer som ikke er brukt (sjekkes i API-et).
--  * parent_id: «Lag egen kopi» av en felles tariff eller en tidligere versjon.
--  * Låste kjøringer lagrer hele tariffen i input_snapshot, så endringer her påvirker aldri sendte tilbud.

begin;

alter table calc.tariffs
  add column if not exists archived_at timestamptz,
  add column if not exists parent_id   uuid references calc.tariffs(id) on delete set null,
  add column if not exists updated_at  timestamptz not null default now(),
  add column if not exists updated_by  uuid references auth.users(id);

drop trigger if exists touch_updated_at on calc.tariffs;
create trigger touch_updated_at before update on calc.tariffs
  for each row execute function calc.touch_updated_at();

-- Linja 2024 gjelder kundegruppen «over 100 000 kWh». Gjør grensen og det som er inkludert synlig.
update calc.tariffs
set definition = definition || $json${
  "minAnnualKwh": 100000,
  "includedNote": "Fastleddet inkluderer Enova-påslaget (800 kr/år). Elavgift og mva. kommer i tillegg."
}$json$::jsonb
where code = 'linja-2024-lavspent-over-100k';

commit;
