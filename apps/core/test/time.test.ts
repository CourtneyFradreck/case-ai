import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { yesterdayWindow, inWindow } from "../src/time.js";

const harare = (iso: string) => DateTime.fromISO(iso, { zone: "Africa/Harare" });
const now = harare("2026-10-14T07:00");

describe("yesterdayWindow", () => {
  it("spans Harare midnight to midnight for the previous day, expressed in UTC", () => {
    const w = yesterdayWindow(now);
    expect(w.start.toISOString()).toBe("2026-10-12T22:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-13T22:00:00.000Z");
  });

  it("labels the window with the previous day's weekday, date and month", () => {
    expect(yesterdayWindow(now).label).toBe("Tuesday 13 Oct");
  });

  it("gives the same window when run just after Harare midnight", () => {
    const early = yesterdayWindow(harare("2026-10-14T00:05"));
    const w = yesterdayWindow(now);
    expect(early.start.toISOString()).toBe(w.start.toISOString());
    expect(early.end.toISOString()).toBe(w.end.toISOString());
    expect(early.label).toBe(w.label);
  });
});

describe("inWindow", () => {
  const w = yesterdayWindow(now);

  it("includes a commit late in the evening Harare time", () => {
    expect(inWindow("2026-10-13T21:30:00Z", w)).toBe(true); // 23:30 Harare, 13 Oct
  });

  it("excludes a commit just after Harare midnight even though its UTC date is still the 13th", () => {
    expect(inWindow("2026-10-13T22:10:00Z", w)).toBe(false); // 00:10 Harare, 14 Oct
  });

  it("treats the start as inclusive", () => {
    expect(inWindow("2026-10-12T22:00:00Z", w)).toBe(true);
  });

  it("treats the end as exclusive", () => {
    expect(inWindow("2026-10-13T22:00:00Z", w)).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(inWindow(null, w)).toBe(false);
    expect(inWindow(undefined, w)).toBe(false);
  });
});
