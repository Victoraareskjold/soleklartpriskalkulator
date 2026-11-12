// Nettselskap og nettområde fra adressen.
// 1. Punktet slås opp i NVEs kart over områdekonsesjoner (gis3.nve.no). Svaret leses ved å lete etter
//    kjente selskapsnavn i alle attributtene, så det tåler at feltnavnene i tjenesten endres.
// 2. Svarer ikke NVE (eller punktet ligger utenfor), brukes en grov kommuneliste for områdene vi selger i.
//    Kommunen avgjør aldri alene: forslaget merkes, og flere kandidater vises når kommunen er delt.
// Glitre Nett har egne priser i tidligere Norgesnett-område (bl.a. Fredrikstad og Hvaler) i 2026.

export interface GridCompany {
  code: string;
  name: string;
}

export interface GridAreaResult {
  /** Treff, best først. Tom = fant ikke selskapet i tariffregisteret */
  companies: (GridCompany & { area: string | null; areaNote?: string })[];
  /** Navn slik kilden oppga dem (også selskaper vi ikke har tariffer for) */
  rawNames: string[];
  source: "nve" | "kommune" | "ingen";
  note: string;
}

const COMPANIES: { code: string; name: string; match: RegExp }[] = [
  { code: "EL", name: "Elvia", match: /\belvia\b|hafslund nett|eidsiva nett/i },
  { code: "GL", name: "Glitre Nett", match: /glitre|norgesnett|agder energi nett/i },
  { code: "LD", name: "Lede", match: /\blede\b|skagerak nett/i },
  { code: "LI", name: "Linja", match: /\blinja\b|mørenett|morenett/i },
  { code: "NV", name: "Nordvest Nett", match: /nordvest nett/i },
  { code: "ET", name: "Etna Nett", match: /\betna\b/i },
  { code: "VV", name: "Vevig", match: /\bvevig\b|eidefoss nett/i },
  { code: "FA", name: "Fagne", match: /\bfagne\b|haugaland kraft nett/i },
];

/** Kommuner der tidligere Norgesnett hadde områdekonsesjon (Østfold-delen). */
const NORGESNETT_KOMMUNER = ["fredrikstad", "hvaler"];

/** Grov reserve når NVE ikke svarer: kommune → mulige selskaper (alle må bekreftes mot faktura). */
const BY_KOMMUNE: Record<string, string[]> = {
  drammen: ["GL", "LD"], // Svelvik-delen ligger i Lede sitt område
  lier: ["GL"],
  kristiansand: ["GL"],
  fredrikstad: ["EL", "GL"],
  hvaler: ["GL"],
  sarpsborg: ["EL"],
  moss: ["EL"],
  porsgrunn: ["LD"],
  skien: ["LD"],
  bamble: ["LD"],
  holmestrand: ["LD", "GL"],
  ålesund: ["LI", "NV"],
  giske: ["LI", "NV"],
  sula: ["LI", "NV"],
  ørsta: ["NV", "LI"],
  volda: ["NV", "LI"],
  ullensaker: ["EL"],
  elverum: ["EL"],
  "nordre land": ["ET"],
  "søndre land": ["ET"],
  sel: ["VV"],
  vågå: ["VV"],
  lom: ["VV"],
  nordfron: ["VV"],
  sørfron: ["VV"],
  haugesund: ["FA"],
  karmøy: ["FA"],
  tysvær: ["FA"],
};

const norm = (s: string) => s.trim().toLowerCase();

export function companyFromName(text: string): GridCompany | null {
  const c = COMPANIES.find((x) => x.match.test(text));
  return c ? { code: c.code, name: c.name } : null;
}

export function companyName(code: string) {
  return COMPANIES.find((c) => c.code === code)?.name ?? code;
}

/** Område for Glitre: tidligere Norgesnett når kilden sier det, eller kommunen er Fredrikstad/Hvaler. */
function glitreArea(rawNames: string[], municipality: string | null): { area: string; note?: string } {
  if (rawNames.some((n) => /norgesnett/i.test(n))) return { area: "tidligere_norgesnett_fredrikstad_mfl", note: "NVE oppgir tidligere Norgesnett" };
  if (municipality && NORGESNETT_KOMMUNER.includes(norm(municipality)))
    return { area: "tidligere_norgesnett_fredrikstad_mfl", note: `${municipality}: tidligere Norgesnett-område (kontroller faktura)` };
  return { area: "glitre_tidligere_agder_buskerud_hadeland" };
}

/** Leser et identify-svar fra NVEs kartjeneste (ArcGIS REST): alle tekstverdier i attributtene. */
export function namesFromNve(json: unknown): string[] {
  const results = (json as { results?: { attributes?: Record<string, unknown>; value?: unknown; layerName?: string }[] } | null)?.results ?? [];
  const names = new Set<string>();
  for (const r of results) {
    for (const v of Object.values(r.attributes ?? {})) if (typeof v === "string" && v.trim().length > 2 && !/^https?:/i.test(v)) names.add(v.trim());
    if (typeof r.value === "string") names.add(r.value.trim());
  }
  return [...names];
}

export function gridAreaFrom(rawNames: string[], municipality: string | null, nveOk: boolean): GridAreaResult {
  const found = new Map<string, GridCompany>();
  for (const n of rawNames) {
    const c = companyFromName(n);
    if (c) found.set(c.code, c);
  }
  const withArea = (c: GridCompany) => (c.code === "GL" ? { ...c, ...glitreArea(rawNames, municipality) } : { ...c, area: "hele_nettomraadet" as string | null });
  if (found.size) {
    return {
      companies: [...found.values()].map((c) => {
        const a = withArea(c);
        return { ...a, areaNote: (a as { note?: string }).note };
      }),
      rawNames,
      source: "nve",
      note: "Fra NVEs kart over områdekonsesjoner. Kontroller nettselskap og produkt mot kundens nettleiefaktura.",
    };
  }
  const codes = municipality ? BY_KOMMUNE[norm(municipality)] : undefined;
  if (codes?.length) {
    return {
      companies: codes.map((code) => {
        const a = withArea({ code, name: companyName(code) });
        return { ...a, areaNote: (a as { note?: string }).note };
      }),
      rawNames,
      source: "kommune",
      note: `${nveOk ? "NVE fant ikke et nettselskap vi har tariffer for" : "NVEs kart svarte ikke"}. Forslag fra kommunen (${municipality}) – kommunen kan ha flere nettselskap; kontroller mot fakturaen.`,
    };
  }
  return {
    companies: [],
    rawNames,
    source: "ingen",
    note: rawNames.length
      ? `Nettselskapet (${rawNames.slice(0, 2).join(", ")}) finnes ikke i tariffregisteret ennå. Legg inn satsene fra fakturaen eller lag en egen tariff.`
      : "Fant ikke nettselskapet for adressen. Velg tariff manuelt eller legg inn fra faktura.",
  };
}

/** URL for punktoppslag i NVEs områdekonsesjoner (WGS84). */
export function nveIdentifyUrl(lat: number, lon: number) {
  const d = 0.01;
  return `https://gis3.nve.no/map/rest/services/Mapservices/Omradekonsesjoner/MapServer/identify?${new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: "all",
    tolerance: "1",
    mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`,
    imageDisplay: "400,400,96",
    returnGeometry: "false",
    f: "json",
  })}`;
}
