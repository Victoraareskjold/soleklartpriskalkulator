import { describe, expect, test } from "vitest";
import { readWorkbookBuffer, parseCsv, ImportError } from "../import/read";

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
