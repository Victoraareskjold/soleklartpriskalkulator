import { describe, expect, test } from "vitest";
import { HOUR, osloLocalToUtc, osloParts, hoursInYear } from "../time";

describe("tid og sommertid", () => {
  test("skuddår 2024 har 8784 timer fra lokal årsstart til neste", () => {
    const a = osloLocalToUtc(2024, 1, 1, 0)[0];
    const b = osloLocalToUtc(2025, 1, 1, 0)[0];
    expect((b - a) / HOUR).toBe(8784);
    expect(hoursInYear(2025)).toBe(8760);
  });
  test("31.3.2024 har 23 timer og 27.10.2024 har 25", () => {
    const len = (m: number, day: number, m2: number, d2: number) =>
      (osloLocalToUtc(2024, m2, d2, 0)[0] - osloLocalToUtc(2024, m, day, 0)[0]) / HOUR;
    expect(len(3, 31, 4, 1)).toBe(23);
    expect(len(10, 27, 10, 28)).toBe(25);
  });
  test("02:00 finnes ikke om våren og finnes to ganger om høsten", () => {
    expect(osloLocalToUtc(2024, 3, 31, 2)).toEqual([]);
    const two = osloLocalToUtc(2024, 10, 27, 2);
    expect(two.length).toBe(2);
    expect(two[1] - two[0]).toBe(HOUR);
  });
  test("lokal tid tilbake fra UTC", () => {
    const p = osloParts(Date.UTC(2024, 6, 1, 10));
    expect([p.hour, p.weekday]).toEqual([12, 1]); // mandag 1. juli, sommertid
  });
});
