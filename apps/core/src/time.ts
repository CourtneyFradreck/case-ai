import { DateTime } from "luxon";

export const ZONE = "Africa/Harare";

export interface Window { start: Date; end: Date; label: string }

export function yesterdayWindow(now: DateTime = DateTime.now()): Window {
  const today = now.setZone(ZONE).startOf("day");
  const start = today.minus({ days: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: today.toUTC().toJSDate(),
    label: "yesterday",
  };
}

// Collect completed local days; today's activity belongs in the next brief.
export function pastWeekWindow(now: DateTime = DateTime.now()): Window {
  const today = now.setZone(ZONE).startOf("day");
  return { start: today.minus({ days: 7 }).toJSDate(), end: today.toJSDate(), label: "past week" };
}

export const inWindow = (iso: string | null | undefined, w: Window) =>
  !!iso && new Date(iso) >= w.start && new Date(iso) < w.end;
