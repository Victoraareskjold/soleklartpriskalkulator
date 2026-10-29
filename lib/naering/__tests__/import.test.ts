import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { readWorkbookBuffer, parseCsv, ImportError } from "../import/read";

const readWorkbook = (path: string) => readWorkbookBuffer(new Uint8Array(readFileSync(path)), path.split("/").pop()!);
import { detect } from "../import/detect";
import { normalize } from "../import/normalize";
import { simulate } from "../engine";
import { LINJA_2024_LAVSPENT_STOR as T } from "../tariff";
import { hasVedlegg, VEDLEGG, buy, sell, taxes } from "./helpers";

describe("filtyper", () => {
  test("gamle .xls og ukjente filer avvises med forklaring", () => {
    expect(() => readWorkbookBuffer(new Uint8Array([1, 2, 3]), "rapport.xls")).toThrow(/xlsx eller .csv/);
    expect(() => readWorkbookBuffer(new Uint8Array([1, 2, 3]), "rapport.xlsx")).toThrow(ImportError);
    expect(() => readWorkbookBuffer(new Uint8Array([1]), "bilde.png")).toThrow(/Ukjent filtype/);
  });
});

describe("CSV", () => {
  test("semikolon og desimalkomma", () => {
    const rows = parseCsv("Tid;Forbruk (kWh)\n01.01.2025 00:00;1 234,5\n01.01.2025 01:00;7,25\n");
    expect(rows[1]).toEqual(["01.01.2025 00:00", 1234.5]);
    expect(rows[2][1]).toBe(7.25);
  });
});

describe.skipIf(!hasVedlegg)("Ålesund-filene", () => {
  // Leses bare når vedleggene finnes (describe-kroppen kjøres også når blokken hoppes over)
  const d = hasVedlegg ? detect(readWorkbook(VEDLEGG + "01_Forbruk_Aalesund_2024.xlsx")) : { candidates: [] as ReturnType<typeof detect>["candidates"] };
  const meters = d.candidates.filter((c) => c.meterId);

  test("finner tre målere med metadata og sone-summen som aggregat", () => {
    expect(meters.map((m) => m.meterId)).toEqual(["707057500010782737", "707057500010782768", "707057500010782775"]);
    expect(meters.every((m) => m.priceArea === "NO3" && /Linja/.test(m.gridOwner ?? ""))).toBe(true);
    const zone = d.candidates.find((c) => c.sheet === "Soner")!;
    expect(zone.aggregateOf?.length).toBe(3);
  });

  test("filens summer er urørt (Asbjørns kontrolltall)", () => {
    const raw = meters.map((m) => m.rows.reduce((a, r) => a + r.value, 0));
    expect(raw[0]).toBeCloseTo(696421.321, 2);
    expect(raw[1]).toBeCloseTo(691180.52, 2);
    expect(raw[2]).toBeCloseTo(283235.67, 2);
  });

  test("sommertid: vårtimen fjernes, den doble høsttimen mangler og merkes", () => {
    const { report } = normalize(meters[0], { kind: "forbruk", unit: "kWh" });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("SOMMERTID_VAR");
    expect(codes).toContain("SOMMERTID_HOST");
    expect(report.intervals).toBe(8784);
    expect(report.estimated).toBe(1);
  });

  // Kontroll mot kostnadsrapporten (fil 02). Satser er IKKE tilpasset rapporten,
  // bortsett fra satsendringen 1.7.2024, som er dokumentert som avledet.
  const cost = hasVedlegg ? readWorkbook(VEDLEGG + "02_Kostnader_Aalesund_2024.xlsx").sheets.find((x) => x.name === "Kostnad for målere")!.rows : [];
  const report: Record<string, number[][]> = {};
  let cur = "";
  for (const r of cost.slice(1)) {
    if (r[9]) cur = String(r[9]);
    if (typeof r[1] === "number") (report[cur] ??= []).push(r.slice(1, 8) as number[]);
  }

  for (const [mi, id] of ["707057500010782737", "707057500010782768", "707057500010782775"].entries()) {
    test(`måler …${id.slice(-3)}: energi, nettleie, effektledd og elavgift mot kostnadsrapporten`, () => {
      const { series } = normalize(meters[mi], { kind: "forbruk", unit: "kWh" });
      const spot = { ...series, kind: "pris" as const, unit: "NOK/kWh" as const, values: new Float64Array(series.values.length) };
      const r = simulate({ load: series, spot, buy, sell, tariff: T, taxes, pv: null });
      r.months.forEach((m, i) => {
        const [effekt, nett, avgift, , , , kwh] = report[id][i];
        const octHourEstimated = i === 9; // én estimert time i oktober
        expect(Math.abs(m.loadKwh - kwh)).toBeLessThan(octHourEstimated ? 4 : 0.01);
        expect(m.cost.effektledd).toBeCloseTo(effekt, 1);
        expect(Math.abs(m.cost.elavgift - avgift)).toBeLessThan(octHourEstimated ? 0.05 : 0.01);
        const unexplained = id.endsWith("768") && i >= 4 && i <= 8; // mai–sep: ukjent tillegg i rapporten
        if (!unexplained) expect(Math.abs(m.cost.fastledd + m.cost.energiledd - nett)).toBeLessThan(octHourEstimated ? 0.3 : 0.02);
        else expect(nett - (m.cost.fastledd + m.cost.energiledd)).toBeGreaterThan(3000); // dokumentert avvik
      });
    });
  }

  test("hourvalues-filen: slutt-tid, ukjent enhet og tomme celler tolkes ikke som null", () => {
    const c = detect(readWorkbook(VEDLEGG + "03_Forbruk_2024_2025.xlsx")).candidates[0];
    const { report, series } = normalize(c, { kind: "forbruk" });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["TID_SLUTT", "ENHET_UKJENT", "TOMME_SLUTT"]));
    expect(series.values.length).toBe(8760);
    expect(report.sumKwh).toBeCloseTo(154099.42, 1);
    expect(c.roleGuess).toBe("forbruk"); // ikke produksjon pga. filnavn
  });
});
