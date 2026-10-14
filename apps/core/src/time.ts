import { DateTime } from "luxon";

export const ZONE = "Africa/Harare";

export interface Window { start: Date; end: Date; label: string }

export function yesterdayWindow(now: DateTime = DateTime.now()): Window {
  const today = now.setZone(ZONE).startOf("day");
  const start = today.minus({ days: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: today.toUTC().toJSDate(),
    label: start.toFormat("cccc d LLL"),
  };
}

export const inWindow = (iso: string | null | undefined, w: Window) =>
  !!iso && new Date(iso) >= w.start && new Date(iso) < w.end;