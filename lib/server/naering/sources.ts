import "server-only";
// Eksterne datakilder med mellomlager i databasen.
//  • «Beregn med lagret grunnlag» (refresh=false): bruker det som er lagret, henter bare det som mangler.
//  • «Hent oppdaterte kildedata» (refresh=true): henter på nytt og erstatter mellomlageret.
// Et sendt tilbud påvirkes aldri: grunnlaget kopieres til låste serier når tilbudet lagres.
import { asJson, sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { hvaKosterUrl, type HvaKosterRow, type PriceArea } from "@/lib/naering/prices";
import { pvgisUrl, type PvgisVersion, type RoofSurface } from "@/lib/naering/pvgis";
import { priceAreaFromCounty } from "@/lib/naering/settings";

const UA = { "user-agent": "soleklart-kalkulator (naeringsanalyse)" };

async function fetchJson(url: string, label: string, tries = 3): Promise<unknown> {
  let last = "";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500 * i));
  }
  throw new HttpError(502, `${label} svarte ikke (${last}). Prøv igjen, eller bruk lagret grunnlag.`, "SOURCE_UNAVAILABLE");
}

// ---------------------------------------------------------------- spotpriser

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Spotpriser for alle døgn i [from, to] (lokale datoer). Henter manglende døgn parallelt (maks 8 samtidig). */
export async function spotRows(area: PriceArea, from: string, to: string, refresh = false) {
  const days: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); isoDay(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(isoDay(d));
  const cached = refresh
    ? []
    : await sql<{ day: Date; rows: HvaKosterRow[] }[]>`
        select day, rows from calc.spot_prices where price_area = ${area} and day between ${from} and ${to}`;
  const have = new Map(cached.map((r) => [isoDay(new Date(r.day)), r.rows]));
  const missing = days.filter((d) => !have.has(d));
  const unavailable: string[] = [];
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (day) => {
        const [y, m, d] = day.split("-").map(Number);
        const rows = (await fetchJson(hvaKosterUrl(area, y, m, d), "hvakosterstrommen.no")) as HvaKosterRow[] | null;
        if (!rows?.length) return unavailable.push(day);
        have.set(day, rows);
        await sql`
          insert into calc.spot_prices (price_area, day, rows, source)
          values (${area}, ${day}, ${asJson(rows)}, 'hvakosterstrommen.no')
          on conflict (price_area, day) do update set rows = excluded.rows, fetched_at = now()`;
      }),
    );
  }
  return { rows: days.flatMap((d) => have.get(d) ?? []), unavailable, fetched: missing.length - unavailable.length };
}

// ---------------------------------------------------------------- PVGIS

/** Én referanseflate på 1 kWp per (sted, helning, retning, tap, værår). Skaleres lineært med kWp. */
export async function pvgisReference(
  version: PvgisVersion,
  lat: number,
  lon: number,
  s: Pick<RoofSurface, "tiltDeg" | "azimuthDeg" | "lossPct">,
  year: number,
  refresh = false,
) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // v6 hentes fra /power/broadband (eldre mellomlagrede /performance-svar har ingen timeserie)
  const key = `pvgis:${version === "v6" ? "v6power" : version}:${r2(lat)}:${r2(lon)}:t${Math.round(s.tiltDeg)}:a${Math.round(s.azimuthDeg)}:l${s.lossPct}:${year}`;
  if (!refresh) {
    const [hit] = await sql<{ response: unknown; fetched_at: Date }[]>`select response, fetched_at from calc.source_cache where key = ${key}`;
    if (hit) return { response: hit.response, key, fetchedAt: hit.fetched_at.toISOString(), cached: true };
  }
  const url = pvgisUrl(version, r2(lat), r2(lon), { id: "ref", kwp: 1, tiltDeg: Math.round(s.tiltDeg), azimuthDeg: Math.round(s.azimuthDeg), lossPct: s.lossPct, meteringPointId: "-" }, year);
  const response = await fetchJson(url, `PVGIS ${version.replace("_", ".")}`);
  if (!response) throw new HttpError(502, `PVGIS ${version} har ikke data for ${year} her`, "SOURCE_UNAVAILABLE");
  await sql`
    insert into calc.source_cache (key, kind, response) values (${key}, 'pvgis', ${asJson(response)})
    on conflict (key) do update set response = excluded.response, fetched_at = now()`;
  return { response, key, fetchedAt: new Date().toISOString(), cached: false };
}

// ---------------------------------------------------------------- adresse → koordinater og prisområde

/** Kartverkets adressesøk (gratis). Prisområdet er et forslag ut fra fylket og må kontrolleres. */
export async function geocode(address: string) {
  const q = address.trim();
  if (q.length < 3) throw new HttpError(400, "Adressen er for kort", "BAD_REQUEST");
  const key = `geokode:${q.toLowerCase()}`;
  const [hit] = await sql<{ response: GeoHit }[]>`select response from calc.source_cache where key = ${key}`;
  if (hit) return hit.response;
  const json = (await fetchJson(
    `https://ws.geonorge.no/adresser/v1/sok?${new URLSearchParams({ sok: q, fuzzy: "true", treffPerSide: "1", utkoordsys: "4258" })}`,
    "Kartverkets adressesøk",
  )) as { adresser?: { adressetekst: string; postnummer: string; poststed: string; kommunenummer: string; kommunenavn: string; representasjonspunkt: { lat: number; lon: number } }[] } | null;
  const a = json?.adresser?.[0];
  if (!a) throw new HttpError(404, "Fant ikke adressen", "NOT_FOUND");
  const res: GeoHit = {
    address: `${a.adressetekst}, ${a.postnummer} ${a.poststed}`,
    lat: a.representasjonspunkt.lat,
    lon: a.representasjonspunkt.lon,
    municipality: a.kommunenavn,
    priceArea: priceAreaFromCounty(a.kommunenummer.slice(0, 2)),
  };
  await sql`insert into calc.source_cache (key, kind, response) values (${key}, 'geokode', ${asJson(res)}) on conflict (key) do nothing`;
  return res;
}

export interface GeoHit {
  address: string;
  lat: number;
  lon: number;
  municipality: string;
  priceArea: PriceArea | null;
}
