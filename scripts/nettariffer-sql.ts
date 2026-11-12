// Lager db/011_nettariffer_2026.sql fra tariffpakken (lib/naering/data/nettariffer-*.json).
// Kjør: npx tsx scripts/nettariffer-sql.ts > db/011_nettariffer_2026.sql
// Ny tariffpakke: legg JSON-filen i lib/naering/data, endre filnavnet under og lag en ny migrering.
import { readFileSync } from "node:fs";
import { gridDefinitions, gridTariffName, tariffCode, type TariffPackage } from "../lib/naering/nettariffRegistry";

const FILE = "lib/naering/data/nettariffer-2026-11-08.json";
const pkg = JSON.parse(readFileSync(FILE, "utf8")) as TariffPackage;
const defs = gridDefinitions(pkg);
const q = (s: string | null) => (s == null ? "null" : `'${s.replaceAll("'", "''")}'`);

const rows = defs.map((d) => {
  const first = d.versions[0];
  const url = first ? d.sources[first.kilder[0]]?.url ?? null : null;
  const group = d.product.vilkaar;
  return `  (${q(tariffCode(d.product.id, d.area))}, ${q(d.product.nettselskap)}, ${q(gridTariffName(d))}, ${q(group)}, ${q(first?.dekket_fra ?? `${d.coveredYear}-01-01`)}, ${q(`${d.coveredYear}-12-31`)},
   $json$${JSON.stringify(d)}$json$::jsonb, ${q(url)}, ${q(d.checked)})`;
});

process.stdout.write(`-- 011 – nettariffer 2026 (Elvia, Glitre Nett, Lede, Linja, Nordvest Nett, Etna Nett, Vevig, Fagne)
--
-- Generert av scripts/nettariffer-sql.ts fra ${FILE} (pakke ${pkg.versjon}, kontrollert ${pkg.sjekket_dato}).
-- Kjøres etter 010. Trygg å kjøre flere ganger.
--  * Én rad per produkt og nettområde. Prisversjonene (datoer) ligger i definition.versions; beregningen
--    velger versjon for hver dato. Satser etter ${pkg.dekningsaar_for_uttak.join(", ")} er bare anslag (merkes i analysen).
--  * Tidligere forhåndsdefinerte felles tariffer arkiveres: de vises ikke for nye valg, men analyser og
--    sendte tilbud som bruker dem beholdes. Låste kjøringer har hele tariffen i input_snapshot og endres ikke.
--  * Teamenes egne tariffer (fra faktura eller egne) berøres ikke.

begin;

insert into calc.tariffs (code, grid_owner, name, customer_group, valid_from, valid_to, definition, source_url, last_checked)
values
${rows.join(",\n")}
on conflict (code) do update set
  grid_owner = excluded.grid_owner,
  name = excluded.name,
  customer_group = excluded.customer_group,
  valid_from = excluded.valid_from,
  valid_to = excluded.valid_to,
  definition = excluded.definition,
  source_url = excluded.source_url,
  last_checked = excluded.last_checked,
  archived_at = null;

update calc.tariffs
set archived_at = now()
where team_id is null
  and archived_at is null
  and coalesce(definition->>'format', '') <> 'nettariff-v1';

commit;
`);
